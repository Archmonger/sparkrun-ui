import { os, eventIterator } from "@orpc/server";
import { z } from "zod";
import { ClusterStatusSchema, type ClusterStatus } from "@/lib/schemas";
import { runSparkrunJson } from "@/lib/sparkrun";

async function fetchStatus(): Promise<ClusterStatus> {
  const raw = await runSparkrunJson<unknown>(["cluster", "status", "--json"]);
  return ClusterStatusSchema.parse(raw);
}

export const get = os.output(ClusterStatusSchema).handler(fetchStatus);

export const stream = os
  .input(z.object({ intervalMs: z.number().int().min(500).max(30_000).default(3000) }).optional())
  .output(eventIterator(ClusterStatusSchema))
  .handler(async function* ({ input, signal }) {
    const interval = input?.intervalMs ?? 3000;
    // Throttle repeated identical errors so a persistent sparkrun failure
    // (most commonly: the container's `app` user can't find `docker` on
    // PATH because the entrypoint didn't export one — see issue #122)
    // doesn't flood the server log every refresh tick.
    let lastLogged: string | null = null;
    while (!signal?.aborted) {
      try {
        const next = await fetchStatus();
        lastLogged = null;
        yield next;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg !== lastLogged) {
          console.error(`[status.stream] ${msg}`);
          lastLogged = msg;
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  });