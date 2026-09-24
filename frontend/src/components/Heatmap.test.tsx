import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Position } from "@/lib/types";
import { Heatmap, heatColor, layoutTreemap } from "./Heatmap";
import { PositionsTable } from "./PositionsTable";
import { snapshotsToSeries } from "./PnlChart";

const pos = (ticker: string, market_value: number, unrealized_pnl: number): Position => ({
  ticker,
  quantity: 1,
  avg_cost: market_value - unrealized_pnl,
  current_price: market_value,
  market_value,
  unrealized_pnl,
  pnl_percent: (unrealized_pnl / (market_value - unrealized_pnl)) * 100,
  weight: 0,
});

describe("layoutTreemap", () => {
  it("sizes cells by market value within the bounds", () => {
    const cells = layoutTreemap([pos("AAPL", 300, 10), pos("TSLA", 100, -5)], 400, 100);
    expect(cells).toHaveLength(2);
    const area = (t: string) => {
      const c = cells.find((x) => x.ticker === t)!;
      return c.w * c.h;
    };
    expect(area("AAPL")).toBeGreaterThan(area("TSLA") * 2);
    for (const c of cells) {
      expect(c.x + c.w).toBeLessThanOrEqual(400);
      expect(c.y + c.h).toBeLessThanOrEqual(100);
    }
  });

  it("returns nothing without positions or size", () => {
    expect(layoutTreemap([], 100, 100)).toEqual([]);
    expect(layoutTreemap([pos("A", 1, 0)], 0, 0)).toEqual([]);
  });
});

describe("heatColor", () => {
  it("uses green for gains, red for losses, grey when flat", () => {
    expect(heatColor(10, 5)).toContain("34 192 122");
    expect(heatColor(-10, -5)).toContain("239 79 95");
    expect(heatColor(0, 0)).toBe("rgb(45 55 70)");
  });
});

describe("Heatmap", () => {
  it("shows an empty state without positions", () => {
    render(<Heatmap positions={[]} />);
    expect(screen.getByTestId("heatmap")).toHaveTextContent("No positions yet");
  });
});

describe("PositionsTable", () => {
  it("renders one row per position with formatted P&L", () => {
    render(<PositionsTable positions={[pos("AAPL", 110, 10), pos("TSLA", 90, -10)]} />);
    expect(screen.getByTestId("position-row-AAPL")).toHaveTextContent("+$10.00");
    expect(screen.getByTestId("position-row-AAPL")).toHaveTextContent("+10.00%");
    expect(screen.getByTestId("position-row-TSLA")).toHaveTextContent("-$10.00");
  });
});

describe("snapshotsToSeries", () => {
  it("orders and de-duplicates by second", () => {
    const out = snapshotsToSeries([
      { total_value: 10000, recorded_at: "2026-01-01T00:00:00.100Z" },
      { total_value: 10010, recorded_at: "2026-01-01T00:00:00.900Z" },
      { total_value: 10020, recorded_at: "2026-01-01T00:00:30Z" },
    ]);
    expect(out.map((p) => p.value)).toEqual([10010, 10020]);
  });
});
