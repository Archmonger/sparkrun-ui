#!/bin/bash
# Drop privileges to the `app` user after fixing up the docker socket group
# and a usable PATH for sparkrun / ssh / docker.
#
# When a sparkrun cluster targets 127.0.0.1, sparkrun runs `docker` locally
# (no SSH). Inside this container that means we need access to the hosts
# docker daemon via a bind-mounted /var/run/docker.sock. The socket is owned
# by root:docker on the host, and the hosts docker GID is unpredictable, so
# we read it from the mounted socket and grant the app user access at start.
set -e

if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c "%g" /var/run/docker.sock)
  if [ -n "$SOCK_GID" ] && [ "$SOCK_GID" != "0" ]; then
    if ! getent group "$SOCK_GID" >/dev/null; then
      groupadd -g "$SOCK_GID" docker-host
    fi
    GROUP_NAME=$(getent group "$SOCK_GID" | head -n1 | cut -d: -f1)
    usermod -aG "$GROUP_NAME" app
  fi
fi

# Ensure sparkrun knows the host user for SSH.  sparkrun always uses SSH
# for cluster monitoring (even for 127.0.0.1), so the containers default
# OS user (app) wont authenticate against the host unless we configure
# the real host user in sparkruns config.
#
# The config file is bind-mounted from the host, so it often already
# exists (e.g. from `sparkrun cluster create`) but doesnt have an
# `ssh:` block - the hosts OS user works for SSH there, so sparkrun
# never needed one configured. We append the block when missing instead
# of only writing on a fresh install; otherwise the in-container `app`
# user gets used for SSH and every metric comes back empty.
if [ -n "${HOST_USER}" ] && [ "${HOST_USER}" != "app" ]; then
  SPARKRUN_CONFIG="$HOME/.config/sparkrun/config.yaml"
  mkdir -p "$(dirname "$SPARKRUN_CONFIG")"
  if ! grep -qE "^ssh:[[:space:]]*$" "$SPARKRUN_CONFIG" 2>/dev/null; then
    printf "\nssh:\n  user: %s\n" "$HOST_USER" >> "$SPARKRUN_CONFIG"
  fi
fi

# Install a writable sparkrun wrapper that shadows the read-only bind mount.
#
# The compose file bind-mounts the host's ~/.local/bin/sparkrun (the uv
# shim) at /usr/local/bin/sparkrun in RO mode. That shim has its shebang
# hardcoded to the host's install path (e.g.
# #!/home/mark/.local/share/uv/tools/sparkrun/bin/python), and that
# interpreter is itself a symlink to /home/mark/.local/share/uv/python/...
# which is NOT inside the bind mount. Inside the container, the shebang
# therefore points to a path that doesn't exist, so spawning `sparkrun`
# fails with "required file not found" (kernel reports ENOENT to Node).
# The venv site-packages ARE bind-mounted (so the .py files are visible)
# but the Python interpreter binary isn't.
#
# We install our own wrapper at /usr/local/sbin/sparkrun and put that
# directory first in PATH so it shadows the bind-mounted shim. The
# wrapper uses the container's python (3.12, baked into the image) with
# PYTHONPATH pointing at the bind-mounted venv's site-packages.
#
# Site-packages discovery: the venv is bind-mounted into the container
# under whatever path the compose file specified, which uses the host's
# $HOME literally (not the container user's $HOME). We don't know the
# host username from inside the container, so we walk /home/* looking
# for a directory tree containing bin/sparkrun AND a python3.* site-packages.
WRAPPER=/usr/local/sbin/sparkrun
mkdir -p "$(dirname "$WRAPPER")"

SPARKRUN_SITE=""
if [ -x /usr/local/bin/sparkrun ]; then
  # The shim is bind-mounted. Look for the matching venv under any
  # /home/<user>/.local/share/uv/tools/sparkrun/lib/python*/site-packages.
  # We avoid scanning /home/app (the in-container user has no .local/uv
  # bind mount) by excluding the image's standard users. If multiple
  # matches exist (shouldn't, but be defensive), pick the first.
  for candidate in /home/*/.local/share/uv/tools/sparkrun; do
    if [ -d "$candidate/lib" ]; then
      found="$(find "$candidate/lib" -maxdepth 2 -name 'site-packages' -type d 2>/dev/null | head -1)"
      if [ -n "$found" ] && [ -d "$found/sparkrun" ]; then
        SPARKRUN_SITE="$found"
        break
      fi
    fi
  done
fi

if [ -z "$SPARKRUN_SITE" ]; then
  echo "WARNING: sparkrun wrapper could not locate venv site-packages under /home/*/.local/share/uv/tools/sparkrun/lib/" >&2
  echo "  sparkrun invocations from inside the container will fail." >&2
  cat > "$WRAPPER" <<NOOP_EOF
#!/bin/bash
echo "sparkrun wrapper: bind-mounted venv site-packages not found" >&2
exit 127
NOOP_EOF
  chmod 0755 "$WRAPPER"
else
  cat > "$WRAPPER" <<WRAPPER_EOF
#!/bin/bash
# Wrapper around the bind-mounted sparkrun shim. The shim's shebang is
# broken inside this container (it points at the host's uv-managed
# Python interpreter, which isn't bind-mounted). We use the image's
# Python and PYTHONPATH to load sparkrun from the bind-mounted venv.
exec /usr/local/bin/python \\
  -c "import sys, runpy; sys.path.insert(0, '$SPARKRUN_SITE'); runpy.run_module('sparkrun', run_name='__main__')" \\
  "\$@"
WRAPPER_EOF
  chmod 0755 "$WRAPPER"
fi

# Give the `app` user a sane PATH before we drop privileges.
#
# `gosu app` (and any process spawned under the in-container `app` user)
# inherits PATH from the login environment, but `app` was created via
# `useradd --system` with no login shell config - so on a freshly-built
# image PATH is empty inside the container. That breaks two things:
#
#   * `sparkrun cluster monitor` invokes the system `ssh` binary on every
#     host (including 127.0.0.1). When PATH is empty the spawn fails with
#     `[Errno 2] No such file or directory: "ssh"` and every monitor
#     tick carries an `error` field with no metrics, which the dashboard
#     renders as zeros (issue #122, before the v1.2.7 partial fix).
#   * `sparkrun cluster status` calls `docker` directly when a host
#     resolves to 127.0.0.1. Same empty-PATH problem causes every host
#     to error out, which collapses the dashboards container list to
#     empty ("containers also dont appear anymore").
#
# We export PATH for `exec gosu app` so child processes inherit it, and
# we write /etc/profile.d/sparkrun-ui.sh so PATH is also set for any
# future shell that logs in as `app` (e.g. `docker exec -u app ... bash`
# for ad-hoc debugging). /usr/local/sbin must come first so our wrapper
# above shadows the bind-mounted shim at /usr/local/bin/sparkrun.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
APP_PROFILE=/etc/profile.d/sparkrun-ui.sh
{
  echo "# Generated by docker/entrypoint.sh - do not edit by hand."
  echo "export PATH=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\${PATH:+:\$PATH}\""
} > "$APP_PROFILE"
chmod 0644 "$APP_PROFILE"

exec gosu app "$@"