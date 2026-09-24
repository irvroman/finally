import { expect, Locator, test } from "@playwright/test";
import { ensureCash, getPortfolio, trade, waitForPrice } from "../support/api";

// PLAN §12: "Portfolio visualization: heatmap renders with correct colors, P&L chart has data points".

const TICKERS = ["GOOGL", "META"];

function apiPnlSign(pnl: number): "positive" | "negative" | "flat" {
  if (pnl > 0) return "positive";
  if (pnl < 0) return "negative";
  return "flat";
}

/** Parse "rgb(r, g, b)" / "rgba(r, g, b, a)" from computed style. */
function rgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

async function cellBackground(cell: Locator): Promise<[number, number, number]> {
  // The colour may be on the cell itself or on its first child.
  const css = await cell.evaluate((el) => {
    const own = getComputedStyle(el).backgroundColor;
    if (own && own !== "rgba(0, 0, 0, 0)" && own !== "transparent") return own;
    const child = el.firstElementChild as HTMLElement | null;
    return child ? getComputedStyle(child).backgroundColor : own;
  });
  return rgb(css);
}

test.describe("portfolio visualisation", () => {
  test.beforeAll(async ({ request }) => {
    await ensureCash(request, 1500);
    for (const t of TICKERS) {
      await waitForPrice(request, t);
      await trade(request, t, "buy", 1);
    }
  });

  test("heatmap has a cell per position, coloured by P&L", async ({ page, request }) => {
    await page.goto("/");
    const heatmap = page.getByTestId("heatmap");
    await expect(heatmap).toBeVisible();

    const positions = (await getPortfolio(request)).positions;
    await expect(page.locator('[data-testid^="heatmap-cell-"]')).toHaveCount(positions.length);

    for (const t of TICKERS) {
      const cell = page.getByTestId(`heatmap-cell-${t}`);
      await expect(cell).toBeVisible();
      await expect(cell).toHaveAttribute("data-pnl", /^(positive|negative|flat)$/);

      // Prices move continuously, so poll until the UI and API agree on the sign
      // (a near-zero P&L may legitimately show as "flat").
      await expect
        .poll(
          async () => {
            const pos = (await getPortfolio(request)).positions.find((p) => p.ticker === t)!;
            const ui = await cell.getAttribute("data-pnl");
            return ui === apiPnlSign(pos.unrealized_pnl) || (ui === "flat" && Math.abs(pos.pnl_percent) < 1);
          },
          { message: `heatmap-cell-${t} data-pnl never matched the API P&L sign`, timeout: 15_000 },
        )
        .toBe(true);

      const state = await cell.getAttribute("data-pnl");
      const [r, g] = await cellBackground(cell);
      if (state === "positive") expect(g, `${t} positive cell should be green-ish`).toBeGreaterThan(r);
      if (state === "negative") expect(r, `${t} negative cell should be red-ish`).toBeGreaterThan(g);
    }

    // Bigger weight => bigger (or equal) cell area.
    const sized = await Promise.all(
      positions.map(async (p) => {
        const box = await page.getByTestId(`heatmap-cell-${p.ticker}`).boundingBox();
        return { weight: p.weight, area: box ? box.width * box.height : 0 };
      }),
    );
    sized.sort((a, b) => a.weight - b.weight);
    const lightest = sized[0];
    const heaviest = sized[sized.length - 1];
    if (heaviest.weight > lightest.weight * 1.5) {
      expect(heaviest.area).toBeGreaterThan(lightest.area);
    }
  });

  test("P&L chart renders with snapshot data", async ({ page, request }) => {
    const hist = await (await request.get("/api/portfolio/history")).json();
    // Trades in beforeAll each record a snapshot.
    expect(hist.snapshots.length).toBeGreaterThanOrEqual(TICKERS.length);

    await page.goto("/");
    const chart = page.getByTestId("pnl-chart");
    await expect(chart).toBeVisible();
    // lightweight-charts draws to canvas.
    const canvas = chart.locator("canvas").first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(50);
    expect(box!.height).toBeGreaterThan(30);

    // The chart host reports how many snapshots it plotted.
    const points = Number(await chart.locator("[data-points]").first().getAttribute("data-points"));
    expect(points).toBeGreaterThanOrEqual(TICKERS.length);
  });
});
