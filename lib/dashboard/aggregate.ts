/**
 * Pure aggregation helpers for the cluster-overview dashboard card.
 *
 * Extracted from `app/components/dashboard/AggregateStats.tsx` so the
 * behaviour can be unit-tested without a DOM / React renderer. Every
 * export here is deliberately framework-free — no React, no DOM types.
 */

export type HostMetrics = Record<string, string | undefined>;
export type Tick = { timestamp: number; hosts: Record<string, HostMetrics> };

export type HostError = { host: string; message: string };

export type Aggregate = {
  /** Hosts whose `error` field was empty/absent (i.e. real metrics). */
  healthyHostCount: number;
  /** Total hosts the monitor reported on this tick (healthy + errored). */
  totalHostCount: number;
  cpuAvg: number;
  gpuAvg: number;
  memUsedGb: number;
  memTotalGb: number;
  gpuMemUsedGb: number;
  gpuMemTotalGb: number;
  powerW: number;
  cpuTempC: number;
  gpuTempC: number;
  jobsTotal: number;
};

function num(s: string | undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

/**
 * A host entry is considered "errored" when sparkrun's monitor emitted a
 * non-empty `error` string. We treat that as a hard signal — even if
 * some metric fields happen to be populated, the host clearly isn't in a
 * known state, so we exclude it from the aggregate. This is the bug fix
 * for issue #122: previously such hosts were silently rolled into the
 * average as zeros, hiding the real failure from the user.
 */
export function isHostError(m: HostMetrics): string | null {
  const raw = m.error;
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  return null;
}

export function extractErrors(tick: Tick | null): HostError[] {
  if (!tick) return [];
  const out: HostError[] = [];
  for (const [host, m] of Object.entries(tick.hosts)) {
    const err = isHostError(m);
    if (err) out.push({ host, message: err });
  }
  return out;
}

const ZERO_AGGREGATE: Aggregate = {
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
};

export function aggregate(tick: Tick | null): Aggregate {
  if (!tick) return { ...ZERO_AGGREGATE };
  const entries = Object.values(tick.hosts);
  const healthy = entries.filter((m) => !isHostError(m));
  let cpuSum = 0;
  let gpuSum = 0;
  let memUsed = 0;
  let memTotal = 0;
  let gpuMemUsed = 0;
  let gpuMemTotal = 0;
  let power = 0;
  let cpuTemp = 0;
  let gpuTemp = 0;
  let jobs = 0;
  for (const m of healthy) {
    cpuSum += num(m.cpu_usage_pct);
    gpuSum += num(m.gpu_util_pct);
    memUsed += num(m.mem_used_mb);
    memTotal += num(m.mem_total_mb);
    gpuMemUsed += num(m.gpu_mem_used_mb);
    gpuMemTotal += num(m.gpu_mem_total_mb);
    power += num(m.gpu_power_w);
    cpuTemp += num(m.cpu_temp_c);
    gpuTemp += num(m.gpu_temp_c);
    jobs += num(m.sparkrun_jobs);
  }
  const n = healthy.length || 1;
  return {
    healthyHostCount: healthy.length,
    totalHostCount: entries.length,
    cpuAvg: cpuSum / n,
    gpuAvg: gpuSum / n,
    memUsedGb: memUsed / 1024,
    memTotalGb: memTotal / 1024,
    gpuMemUsedGb: gpuMemUsed / 1024,
    gpuMemTotalGb: gpuMemTotal / 1024,
    powerW: power,
    cpuTempC: cpuTemp / n,
    gpuTempC: gpuTemp / n,
    jobsTotal: jobs,
  };
}