"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Cpu, MemoryStick, Server, Thermometer, Zap } from "lucide-react";
import { Card, CardBody } from "@/app/components/ui/Card";
import { rpc } from "@/lib/rpc/client";
import { aggregate, extractErrors, type Tick } from "@/lib/dashboard/aggregate";

const HISTORY = 40;

export function AggregateStats() {
  const [tick, setTick] = useState<Tick | null>(null);
  const [hist, setHist] = useState<{ cpu: number[]; gpu: number[] }>({ cpu: [], gpu: [] });
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const iter = await rpc.monitor.stream({ intervalSec: 2 }, { signal: ac.signal });
        setConnected(true);
        for await (const next of iter) {
          if (cancelled) break;
          setTick(next as Tick);
          const agg = aggregate(next as Tick);
          setHist((prev) => ({
            cpu: push(prev.cpu, agg.cpuAvg),
            gpu: push(prev.gpu, agg.gpuAvg),
          }));
        }
      } catch (err) {
        if (!cancelled && !(err instanceof DOMException && err.name === "AbortError")) {
          console.error("[monitor.stream]", err);
        }
      } finally {
        if (!cancelled) setConnected(false);
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, []);

  const agg = aggregate(tick);
  const errors = useMemo(() => extractErrors(tick), [tick]);
  const memPct = agg.memTotalGb ? (agg.memUsedGb / agg.memTotalGb) * 100 : 0;
  const gpuMemPct = agg.gpuMemTotalGb ? (agg.gpuMemUsedGb / agg.gpuMemTotalGb) * 100 : 0;
  const allErrored = agg.totalHostCount > 0 && agg.healthyHostCount === 0;
  const hostSummary =
    agg.totalHostCount === 0
      ? "—"
      : agg.healthyHostCount === agg.totalHostCount
        ? `${agg.healthyHostCount} host${agg.healthyHostCount === 1 ? "" : "s"}`
        : `${agg.healthyHostCount}/${agg.totalHostCount} host${agg.totalHostCount === 1 ? "" : "s"} reporting`;

  return (
    <div className="flex flex-col gap-3">
      {errors.length > 0 && (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
          <CardBody className="flex gap-3">
            <AlertTriangle
              className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
              size={18}
            />
            <div className="flex flex-col gap-1 text-sm">
              <h3 className="font-medium text-amber-900 dark:text-amber-200">
                {allErrored
                  ? `Cluster monitor returned no metrics for ${agg.totalHostCount} host${agg.totalHostCount === 1 ? "" : "s"}`
                  : `Cluster monitor errored on ${errors.length} of ${agg.totalHostCount} host${agg.totalHostCount === 1 ? "" : "s"}`}
              </h3>
              <ul className="flex flex-col gap-1 text-amber-800 dark:text-amber-300">
                {errors.map((e) => (
                  <li key={e.host} className="font-mono text-xs">
                    <span className="font-semibold">{e.host}:</span> {e.message}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                Common causes: the container&apos;s <code>app</code> user can&apos;t reach the
                host&apos;s SSH daemon (check that <code>~/.ssh/authorized_keys</code> contains
                the public key matching <code>~/.ssh/id_*.pub</code>), or sparkrun itself can&apos;t
                find <code>ssh</code>/<code>docker</code> on <code>PATH</code> inside the
                container.
              </p>
            </div>
          </CardBody>
        </Card>
      )}
      <Card>
        <CardBody className="p-5">
          <div className="mb-4 flex items-baseline justify-between">
            <div className="flex items-center gap-2">
              <Server size={14} className="text-zinc-500" />
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Cluster overview
              </span>
              <span className="text-xs text-zinc-500">
                · {hostSummary} · {agg.jobsTotal} job{agg.jobsTotal === 1 ? "" : "s"}
              </span>
            </div>
            <span
              className={
                "inline-flex h-2 w-2 rounded-full " +
                (connected ? "animate-pulse bg-emerald-500" : "bg-zinc-300")
              }
              title={connected ? "live" : "reconnecting"}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <Stat
              icon={<Cpu size={14} />}
              tone="sky"
              label="CPU"
              value={agg.healthyHostCount === 0 ? "—" : `${agg.cpuAvg.toFixed(1)}%`}
              sub={
                agg.healthyHostCount === 0
                  ? "no host reporting"
                  : `avg across ${agg.healthyHostCount}`
              }
              pct={agg.cpuAvg}
              spark={hist.cpu}
            />
            <Stat
              icon={<Zap size={14} />}
              tone="purple"
              label="GPU"
              value={agg.healthyHostCount === 0 ? "—" : `${agg.gpuAvg.toFixed(0)}%`}
              sub={
                agg.healthyHostCount === 0
                  ? "no host reporting"
                  : `avg across ${agg.healthyHostCount}`
              }
              pct={agg.gpuAvg}
              spark={hist.gpu}
            />
            <Stat
              icon={<MemoryStick size={14} />}
              tone="green"
              label="Memory"
              value={
                agg.healthyHostCount === 0
                  ? "—"
                  : `${agg.memUsedGb.toFixed(0)} / ${agg.memTotalGb.toFixed(0)} GB`
              }
              sub={
                agg.healthyHostCount === 0
                  ? "no host reporting"
                  : `${memPct.toFixed(0)}% used`
              }
              pct={memPct}
            />
            <Stat
              icon={<Zap size={14} />}
              tone="amber"
              label="Power"
              value={agg.healthyHostCount === 0 ? "—" : `${agg.powerW.toFixed(1)} W`}
              sub={
                agg.gpuMemTotalGb
                  ? `GPU mem ${agg.gpuMemUsedGb.toFixed(0)}/${agg.gpuMemTotalGb.toFixed(0)} GB`
                  : "total GPU draw"
              }
              pct={gpuMemPct}
            />
            <Stat
              icon={<Thermometer size={14} />}
              tone="red"
              label="Temps"
              value={
                agg.healthyHostCount === 0 || (!agg.cpuTempC && !agg.gpuTempC)
                  ? "—"
                  : `${agg.gpuTempC.toFixed(0)}°C / ${agg.cpuTempC.toFixed(0)}°C`
              }
              sub="GPU / CPU avg"
              pct={agg.gpuTempC > 0 ? Math.min(100, (agg.gpuTempC / 100) * 100) : 0}
            />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function push(arr: number[], v: number): number[] {
  const next = arr.concat(v);
  return next.length > HISTORY ? next.slice(-HISTORY) : next;
}

const toneBg: Record<string, string> = {
  sky: "bg-sky-500 dark:bg-sky-400",
  purple: "bg-purple-500 dark:bg-purple-400",
  green: "bg-emerald-500 dark:bg-emerald-400",
  amber: "bg-amber-500 dark:bg-amber-400",
  red: "bg-red-500 dark:bg-red-400",
};
const toneStroke: Record<string, string> = {
  sky: "stroke-sky-500 dark:stroke-sky-400",
  purple: "stroke-purple-500 dark:stroke-purple-400",
  green: "stroke-emerald-500 dark:stroke-emerald-400",
  amber: "stroke-amber-500 dark:stroke-amber-400",
};
const toneText: Record<string, string> = {
  sky: "text-sky-600 dark:text-sky-400",
  purple: "text-purple-600 dark:text-purple-400",
  green: "text-emerald-600 dark:text-emerald-400",
  amber: "text-amber-600 dark:text-amber-400",
  red: "text-red-600 dark:text-red-400",
};

function Stat({
  icon,
  label,
  value,
  sub,
  pct,
  tone,
  spark,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  pct: number;
  tone: string;
  spark?: number[];
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-1.5 text-xs font-medium ${toneText[tone]}`}>
          {icon}
          {label}
        </div>
        {spark && spark.length > 2 && <Sparkline values={spark} className={toneStroke[tone]} />}
      </div>
      <div className="font-mono text-xl font-semibold text-zinc-900 dark:text-zinc-100">
        {value}
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`${toneBg[tone]} h-full transition-all duration-300`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{sub}</div>
    </div>
  );
}

function Sparkline({ values, className }: { values: number[]; className: string }) {
  const w = 56;
  const h = 16;
  const max = Math.max(100, ...values);
  const step = w / Math.max(1, values.length - 1);
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${i * step} ${h - (v / max) * h}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="flex-shrink-0">
      <path d={path} fill="none" strokeWidth={1.25} className={className} />
    </svg>
  );
}