"use client";

import { useEffect, useRef } from "react";
import {
  AreaSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { baseChartOptions } from "@/lib/chartTheme";
import { toChartSeries, type PricePoint } from "@/lib/priceStore";
import { formatPercent, formatPrice, signClass } from "@/lib/format";
import { Panel } from "./Panel";

export function MainChart({
  ticker,
  points,
  price,
  change,
}: {
  ticker: string | null;
  points: PricePoint[] | undefined;
  price: number | null;
  change: number | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const shownTicker = useRef<string | null>(null);
  const lastTime = useRef<number>(0);

  useEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, baseChartOptions);
    seriesRef.current = chart.addSeries(AreaSeries, {
      lineColor: "#209dd7",
      topColor: "rgba(32,157,215,0.28)",
      bottomColor: "rgba(32,157,215,0.02)",
      lineWidth: 2,
      priceLineColor: "#ecad0a",
      priceLineStyle: 2,
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      shownTicker.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const data = toChartSeries(points ?? []);
    if (ticker !== shownTicker.current) {
      // New ticker: load the whole history.
      series.setData(data.map((d) => ({ time: d.time as UTCTimestamp, value: d.value })));
      chartRef.current?.timeScale().fitContent();
      shownTicker.current = ticker;
      lastTime.current = data.at(-1)?.time ?? 0;
      return;
    }
    // Same ticker: append/replace only the newest point.
    const last = data.at(-1);
    if (last && last.time >= lastTime.current) {
      const isNewBar = last.time > lastTime.current;
      series.update({ time: last.time as UTCTimestamp, value: last.value });
      lastTime.current = last.time;
      // Keep the whole session in view as it grows.
      if (isNewBar) chartRef.current?.timeScale().fitContent();
    }
  }, [ticker, points]);

  return (
    <Panel
      testId="main-chart"
      className="h-full"
      bodyClassName="relative"
      title={
        <span className="flex items-baseline gap-3">
          <span data-testid="main-chart-ticker" className="text-[14px] font-semibold text-accent">
            {ticker ?? "No symbol selected"}
          </span>
          {ticker && (
            <>
              <span className="num text-[14px] font-medium text-ink">{formatPrice(price)}</span>
              <span className={`num text-[12px] ${signClass(change)}`}>
                {formatPercent(change)} this session
              </span>
            </>
          )}
        </span>
      }
      aside={<span className="text-[11px] text-faint">Since page load</span>}
    >
      <div ref={hostRef} className="absolute inset-0" />
      {ticker && (points?.length ?? 0) < 2 && (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-muted">
          Collecting ticks for {ticker}…
        </p>
      )}
    </Panel>
  );
}
