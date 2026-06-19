import { describe, expect, it } from "vitest";
import { aggregate, extractErrors, isHostError, type Tick } from "./aggregate";

describe("aggregate", () => {
  it("returns all zeros for a null tick", () => {
    const out = aggregate(null);
    expect(out).toEqual({
      healthyHostCount: 0,
      totalHostCount: 0,
      cpuAvg: 0,
      gpuAvg: 0,
      memUsedGb: 0,
      memTotalGb: 0,
      gpuMemUsedGb: 0,
      gpuMemTotalGb: 0,
      powerW: 0,
      cpuTempC: 0,
      gpuTempC: 0,
      jobsTotal: 0,
    });
  });

  it("averages healthy hosts by total healthy host count, not total host count", () => {
    const tick: Tick = {
      timestamp: 0,
      hosts: {
        a: { cpu_usage_pct: "60" },
        b: { cpu_usage_pct: "30" },
        c: { error: "ssh: Permission denied (publickey)." },
      },
    };
    const out = aggregate(tick);
    // 60 + 30 / 2 healthy hosts = 45, NOT 90 / 3 = 30
    expect(out.cpuAvg).toBeCloseTo(45, 6);
    expect(out.healthyHostCount).toBe(2);
    expect(out.totalHostCount).toBe(3);
  });

  it("returns healthyHostCount=0 and totalHostCount=N when every host errored", () => {
    const tick: Tick = {
      timestamp: 0,
      hosts: {
        a: { error: "Failed to start SSH: [Errno 2] No such file or directory: 'ssh'" },
        b: { error: "Permission denied (publickey)." },
      },
    };
    const out = aggregate(tick);
    expect(out.healthyHostCount).toBe(0);
    expect(out.totalHostCount).toBe(2);
    // All metrics stay at zero — the dashboard surfaces the errors
    // banner instead of misleading the user with a "0% CPU" tile.
    expect(out.cpuAvg).toBe(0);
    expect(out.gpuAvg).toBe(0);
    expect(out.powerW).toBe(0);
  });

  it("ignores spurious whitespace-only error strings", () => {
    expect(isHostError({ error: "" })).toBeNull();
    expect(isHostError({ error: "   " })).toBeNull();
    expect(isHostError({ error: "real failure" })).toBe("real failure");
    expect(isHostError({})).toBeNull();
  });

  it("extractErrors returns host + trimmed message for every errored host", () => {
    const tick: Tick = {
      timestamp: 0,
      hosts: {
        "127.0.0.1": { error: "Failed to start SSH: [Errno 2] No such file or directory: 'ssh'" },
        "10.0.0.5": { cpu_usage_pct: "12" },
        "10.0.0.6": { error: "Permission denied (publickey)." },
      },
    };
    const errs = extractErrors(tick);
    expect(errs).toHaveLength(2);
    expect(errs.map((e) => e.host).sort()).toEqual(["10.0.0.6", "127.0.0.1"]);
    for (const e of errs) expect(e.message.length).toBeGreaterThan(0);
  });

  it("sums memory and power across hosts (not averages) since they're already totals", () => {
    const tick: Tick = {
      timestamp: 0,
      hosts: {
        a: { mem_used_mb: "1024", mem_total_mb: "2048", gpu_power_w: "100" },
        b: { mem_used_mb: "2048", mem_total_mb: "4096", gpu_power_w: "200" },
      },
    };
    const out = aggregate(tick);
    expect(out.memUsedGb).toBeCloseTo(3, 6); // (1024+2048) / 1024
    expect(out.memTotalGb).toBeCloseTo(6, 6);
    expect(out.powerW).toBeCloseTo(300, 6);
  });

  it("treats empty / unparseable metric fields as zero", () => {
    const tick: Tick = {
      timestamp: 0,
      hosts: { a: { cpu_usage_pct: "not-a-number", mem_used_mb: "" } },
    };
    const out = aggregate(tick);
    expect(out.cpuAvg).toBe(0);
    expect(out.memUsedGb).toBe(0);
  });
});