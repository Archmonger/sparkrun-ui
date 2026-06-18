import { os, eventIterator } from "@orpc/server";
import { z } from "zod";
import { streamSparkrunNdjson } from "@/lib/sparkrun";

const HostMetricsSchema = z
  .object({
    hostname: z.string().optional(),
    uptime_sec: z.string().optional(),
    cpu_usage_pct: z.string().optional(),
    cpu_temp_c: z.string().optional(),
    cpu_load_1m: z.string().optional(),
    mem_total_mb: z.string().optional(),
    mem_used_mb: z.string().optional(),
    mem_used_pct: z.string().optional(),
    gpu_name: z.string().optional(),
    gpu_util_pct: z.string().optional(),
    gpu_mem_used_mb: z.string().optional(),
    gpu_mem_total_mb: z.string().optional(),
    gpu_temp_c: z.string().optional(),
    gpu_power_w: z.string().optional(),
    gpu_power_limit_w: z.string().optional(),
    sparkrun_jobs: z.string().optional(),
    sparkrun_job_names: z.string().optional(),
    // sparkrun emits this on hosts whose metric collection failed (e.g.
    // SSH auth refused). Surfacing it to the dashboard lets the user
    // see *why* every number is zero, instead of silently rendering an
    // aggregate over no data (issue #122). When set, every metric field
    // above will be absent for the same host.
    error: z.string().optional(),
  })
  .loose();

const TickSchema = z.object({
  timestamp: z.number(),
  hosts: z.record(z.string(), HostMetricsSchema),
});

export const stream = os
  .input(
    z
      .object({
        cluster: z.string().optional(),
        hosts: z.array(z.string()).optional(),
        intervalSec: z.number().int().min(1).max(30).default(2),
      })
      .optional(),
  )
  .output(eventIterator(TickSchema))
  .handler(async function* ({ input, signal }) {
    const args = ["cluster", "monitor", "--json", "--interval", String(input?.intervalSec ?? 2)];
    if (input?.cluster) args.push("--cluster", input.cluster);
    else if (input?.hosts?.length) args.push("--hosts", input.hosts.join(","));
    // Log the first error per host so the server log records WHY the
    // dashboard shows zeros, even when the browser console isn't open.
    const loggedErrors = new Set<string>();
    for await (const obj of streamSparkrunNdjson<z.infer<typeof TickSchema>>(args, { signal })) {
      if (signal?.aborted) break;
      for (const [host, m] of Object.entries(obj.hosts)) {
        if (typeof m.error === "string" && m.error.length > 0 && !loggedErrors.has(host)) {
          loggedErrors.add(host);
          console.error(`[monitor.stream] ${host}: ${m.error}`);
        }
      }
      yield obj;
    }
  });