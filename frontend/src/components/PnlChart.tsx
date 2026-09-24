"use client";

import { useEffect, useRef } from "react";
import { BaselineSeries, createChart, type ISeriesApi, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { baseChartOptions } from "@/lib/chartTheme";
import type { Snapshot } from "@/lib/types";
import { Panel } from "./Panel";

export const STARTING_CASH = 10000;

/** Snapshots → strictly increasing whole-second points for lightweight-charts. */
export function snapshotsToSeries(snapshots: Snapshot[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  for (const s of snapshots) {
    const t = Math.floor(Date.parse(s.recorded_at) / 1000);
    if (!Number.isFinite(t)) continue;
    const last = out[out.length - 1];
    if (last && last.time === t) last.value = s.total_value;
    else if (!last || t > last.time) out.push({ time: t, value: s.total_value });
  }
  return out;
}

export function PnlChart({ snapshots }: { snapshots: Snapshot[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, {
      ...baseChartOptions,
      timeScale: { ...baseChartOptions.timeScale, secondsVisible: false },
    });
    // Green above the $10k starting balance, red below it.
    seriesRef.current = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: STARTING_CASH },
      topLineColor: "#22c07a",
      topFillColor1: "rgba(34,192,122,0.25)",
      topFillColor2: "rgba(34,192,122,0.02)",
      bottomLineColor: "#ef4f5f",
      bottomFillColor1: "rgba(239,79,95,0.02)",
      bottomFillColor2: "rgba(239,79,95,0.25)",
      lineWidth: 2,
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  const data = snapshotsToSeries(snapshots);

  useEffect(() => {
    seriesRef.current?.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
    chartRef.current?.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshots]);

  return (
    <Panel
      testId="pnl-chart"
      title="Portfolio value"
      aside={<span className="num text-[11px] text-faint">{data.length} snapshots</span>}
      className="h-full"
      bodyClassName="relative"
    >
      <div ref={hostRef} data-points={data.length} className="absolute inset-0" />
      {data.length === 0 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-muted">
          Value is recorded every 30 seconds and after each trade.
        </p>
      )}
    </Panel>
  );
}
