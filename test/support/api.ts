import { APIRequestContext, expect } from "@playwright/test";

// Types mirror planning/TEAM_CONTRACT.md §4.

export interface Position {
  ticker: string;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  pnl_percent: number;
  weight: number;
}

export interface Portfolio {
  cash_balance: number;
  total_value: number;
  positions_value: number;
  unrealized_pnl: number;
  positions: Position[];
}

export interface WatchlistItem {
  ticker: string;
  price: number | null;
  previous_price: number | null;
  change: number | null;
  change_percent: number | null;
  direction: string | null;
  timestamp: number | null;
}

export const DEFAULT_TICKERS = [
  "AAPL",
  "GOOGL",
  "MSFT",
  "AMZN",
  "TSLA",
  "NVDA",
  "META",
  "JPM",
  "V",
  "NFLX",
];

/** True when the run is known to start from a freshly seeded database. */
export const FRESH_DB = (process.env.FRESH_DB || "").toLowerCase() === "true";

export async function getPortfolio(request: APIRequestContext): Promise<Portfolio> {
  const res = await request.get("/api/portfolio");
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

export async function getWatchlist(request: APIRequestContext): Promise<WatchlistItem[]> {
  const res = await request.get("/api/watchlist");
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()).tickers;
}

export async function heldQuantity(request: APIRequestContext, ticker: string): Promise<number> {
  const p = await getPortfolio(request);
  return p.positions.find((x) => x.ticker === ticker)?.quantity ?? 0;
}

export async function trade(
  request: APIRequestContext,
  ticker: string,
  side: "buy" | "sell",
  quantity: number,
) {
  const res = await request.post("/api/portfolio/trade", { data: { ticker, side, quantity } });
  expect(res.status(), `trade ${side} ${quantity} ${ticker}: ${await res.text()}`).toBe(200);
  return res.json();
}

/** Sell the entire position in `ticker`, if any. */
export async function closePosition(request: APIRequestContext, ticker: string) {
  const qty = await heldQuantity(request, ticker);
  if (qty > 0) await trade(request, ticker, "sell", qty);
}

/**
 * Make sure there is at least `min` dollars of cash, liquidating positions if an
 * earlier run (on a persistent DB) spent it.
 */
export async function ensureCash(request: APIRequestContext, min: number) {
  let p = await getPortfolio(request);
  for (const pos of [...p.positions].sort((a, b) => b.market_value - a.market_value)) {
    if (p.cash_balance >= min) break;
    await trade(request, pos.ticker, "sell", pos.quantity);
    p = await getPortfolio(request);
  }
  expect(p.cash_balance, "not enough cash even after liquidating").toBeGreaterThanOrEqual(min);
}

export async function ensureOnWatchlist(request: APIRequestContext, ticker: string) {
  const res = await request.post("/api/watchlist", { data: { ticker } });
  expect([200, 201], await res.text()).toContain(res.status());
}

export async function ensureNotOnWatchlist(request: APIRequestContext, ticker: string) {
  const res = await request.delete(`/api/watchlist/${ticker}`);
  expect([200, 404], await res.text()).toContain(res.status());
}

/** Wait until the backend has a live price for `ticker`. */
export async function waitForPrice(request: APIRequestContext, ticker: string): Promise<number> {
  let price: number | null = null;
  await expect
    .poll(
      async () => {
        const item = (await getWatchlist(request)).find((w) => w.ticker === ticker);
        price = item?.price ?? null;
        return price;
      },
      { message: `no price for ${ticker}`, timeout: 15_000 },
    )
    .not.toBeNull();
  return price as unknown as number;
}

/** Parse display money like "$10,000.00" or "-$1,234.5" into a number. */
export function parseMoney(text: string | null): number {
  if (!text) return NaN;
  const negative = /-|\(/.test(text);
  const n = parseFloat(text.replace(/[^0-9.]/g, ""));
  return negative ? -n : n;
}
