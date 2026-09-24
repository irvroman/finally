"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import type { Position } from "@/lib/types";
import { formatPercent } from "@/lib/format";
import { pnlSign } from "@/lib/portfolio";
import { Panel } from "./Panel";

export interface HeatCell {
  ticker: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pnl: number;
  pnlPercent: number;
  weight: number;
}

type TreeDatum = { children: Position[] } | Position;

export function layoutTreemap(positions: Position[], width: number, height: number): HeatCell[] {
  const items = positions.filter((p) => p.market_value > 0);
  if (!items.length || width <= 0 || height <= 0) return [];
  const root = hierarchy<TreeDatum>({ children: items }, (d) =>
    "children" in d ? d.children : undefined,
  )
    .sum((d) => ("market_value" in d ? d.market_value : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const laid = treemap<TreeDatum>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(2)
    .round(true)(root);
  return laid.leaves().map((leaf) => {
    const p = leaf.data as Position;
    return {
      ticker: p.ticker,
      x: leaf.x0,
      y: leaf.y0,
      w: leaf.x1 - leaf.x0,
      h: leaf.y1 - leaf.y0,
      pnl: p.unrealized_pnl,
      pnlPercent: p.pnl_percent,
      weight: p.weight,
    };
  });
}

/** Colour intensity saturates at +/-5% P&L. */
export function heatColor(pnl: number, pnlPercent: number): string {
  const sign = pnlSign(pnl);
  if (sign === "flat") return "rgb(45 55 70)";
  const t = Math.min(Math.abs(pnlPercent) / 5, 1);
  const alpha = (0.2 + t * 0.7).toFixed(2);
  return sign === "positive" ? `rgb(34 192 122 / ${alpha})` : `rgb(239 79 95 / ${alpha})`;
}

export function Heatmap({
  positions,
  onSelect,
}: {
  positions: Position[];
  onSelect?: (ticker: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cells = useMemo(() => layoutTreemap(positions, size.w, size.h), [positions, size]);

  return (
    <Panel
      testId="heatmap"
      title="Holdings map"
      aside={<span className="text-[11px] text-faint">Size = weight, colour = P&amp;L</span>}
      className="h-full"
      bodyClassName="relative p-1"
    >
      <div ref={hostRef} className="relative h-full w-full">
        {cells.map((c) => (
          <button
            type="button"
            key={c.ticker}
            data-testid={`heatmap-cell-${c.ticker}`}
            data-pnl={pnlSign(c.pnl)}
            onClick={() => onSelect?.(c.ticker)}
            title={`${c.ticker}: ${(c.weight * 100).toFixed(1)}% of portfolio, ${formatPercent(c.pnlPercent)}`}
            className="absolute flex flex-col items-start justify-start overflow-hidden p-1.5 text-left hover:brightness-125"
            style={{
              left: c.x,
              top: c.y,
              width: c.w,
              height: c.h,
              background: heatColor(c.pnl, c.pnlPercent),
            }}
          >
            {c.w > 34 && c.h > 18 && (
              <span className="text-[13px] font-semibold text-ink">{c.ticker}</span>
            )}
            {c.w > 48 && c.h > 34 && (
              <span className="num text-[11px] text-ink/85">{formatPercent(c.pnlPercent)}</span>
            )}
          </button>
        ))}
        {positions.length === 0 && (
          <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-muted">
            No positions yet. Buy a symbol with the trade bar to see it here.
          </p>
        )}
      </div>
    </Panel>
  );
}
