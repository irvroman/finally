import { expect, test } from "@playwright/test";
import {
  closePosition,
  ensureCash,
  ensureNotOnWatchlist,
  ensureOnWatchlist,
  getPortfolio,
  getWatchlist,
  heldQuantity,
  trade,
  waitForPrice,
} from "../support/api";

// Contract: planning/TEAM_CONTRACT.md §4 (REST shapes) and §3.3 (LLM mock grammar).
// Every test measures deltas, so a persistent DB with earlier data is fine.

const BASE_URL = process.env.BASE_URL || "http://localhost:8000";

function expectPortfolioShape(p: any) {
  for (const k of ["cash_balance", "total_value", "positions_value", "unrealized_pnl"]) {
    expect(typeof p[k], k).toBe("number");
  }
  expect(Array.isArray(p.positions)).toBe(true);
  for (const pos of p.positions) {
    for (const k of [
      "quantity",
      "avg_cost",
      "current_price",
      "market_value",
      "unrealized_pnl",
      "pnl_percent",
      "weight",
    ]) {
      expect(typeof pos[k], `${pos.ticker}.${k}`).toBe("number");
    }
    expect(pos.ticker).toMatch(/^[A-Z][A-Z0-9.]{0,9}$/);
    expect(pos.weight).toBeGreaterThanOrEqual(0);
    expect(pos.weight).toBeLessThanOrEqual(1);
  }
  expect(p.total_value).toBeCloseTo(p.cash_balance + p.positions_value, 1);
}

test.describe("system", () => {
  test("GET /api/health", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  test("GET /api/stream/prices emits SSE price events", async () => {
    const controller = new AbortController();
    const res = await fetch(`${BASE_URL}/api/stream/prices`, { signal: controller.signal });
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 10_000;
      let payload: any = null;
      while (!payload && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const m = buf.match(/^data: (.+)$/m);
        if (m) payload = JSON.parse(m[1]);
      }
      expect(payload, "no data event within 10s").not.toBeNull();
      const tickers = Object.keys(payload);
      expect(tickers.length).toBeGreaterThan(0);
      const ev = payload[tickers[0]];
      for (const k of ["ticker", "price", "previous_price", "timestamp", "change", "change_percent", "direction"]) {
        expect(ev, k).toHaveProperty(k);
      }
      expect(typeof ev.price).toBe("number");
      expect(typeof ev.timestamp).toBe("number");
    } finally {
      controller.abort();
    }
  });
});

test.describe("portfolio", () => {
  test("GET /api/portfolio shape", async ({ request }) => {
    expectPortfolioShape(await getPortfolio(request));
  });

  test("buy then sell updates cash, position, and history", async ({ request }) => {
    await ensureCash(request, 2000);
    await waitForPrice(request, "MSFT");
    const before = await getPortfolio(request);
    const qtyBefore = before.positions.find((p) => p.ticker === "MSFT")?.quantity ?? 0;
    const historyBefore = (await (await request.get("/api/portfolio/history")).json()).snapshots.length;

    const bought = await trade(request, "MSFT", "buy", 2);
    expect(bought.trade).toMatchObject({ ticker: "MSFT", side: "buy", quantity: 2 });
    for (const k of ["id", "price", "executed_at"]) expect(bought.trade).toHaveProperty(k);
    expectPortfolioShape(bought.portfolio);
    expect(bought.portfolio.cash_balance).toBeCloseTo(before.cash_balance - 2 * bought.trade.price, 1);
    expect(bought.portfolio.positions.find((p: any) => p.ticker === "MSFT").quantity).toBeCloseTo(qtyBefore + 2, 4);

    // A snapshot is recorded immediately after each trade.
    const hist = await (await request.get("/api/portfolio/history")).json();
    expect(hist.snapshots.length).toBeGreaterThan(historyBefore);
    const last = hist.snapshots[hist.snapshots.length - 1];
    expect(typeof last.total_value).toBe("number");
    expect(typeof last.recorded_at).toBe("string");

    const sold = await trade(request, "MSFT", "sell", 1);
    expect(sold.trade).toMatchObject({ ticker: "MSFT", side: "sell", quantity: 1 });
    expect(sold.portfolio.cash_balance).toBeCloseTo(bought.portfolio.cash_balance + sold.trade.price, 1);
    expect(await heldQuantity(request, "MSFT")).toBeCloseTo(qtyBefore + 1, 4);

    // Restore the prior quantity.
    await trade(request, "MSFT", "sell", 1);
    expect(await heldQuantity(request, "MSFT")).toBeCloseTo(qtyBefore, 4);
  });

  test("selling a full position removes it", async ({ request }) => {
    await ensureCash(request, 1000);
    await closePosition(request, "JPM");
    await trade(request, "JPM", "buy", 1.5);
    const res = await trade(request, "JPM", "sell", 1.5);
    expect(res.portfolio.positions.find((p: any) => p.ticker === "JPM")).toBeUndefined();
  });

  test("fractional quantity and lower-case ticker are normalised", async ({ request }) => {
    await ensureCash(request, 1000);
    await waitForPrice(request, "AAPL");
    const res = await request.post("/api/portfolio/trade", {
      data: { ticker: " aapl ", side: "buy", quantity: 0.123456 },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.trade.ticker).toBe("AAPL");
    expect(body.trade.quantity).toBeCloseTo(0.1235, 4);
    await trade(request, "AAPL", "sell", body.trade.quantity);
  });

  test("buy with insufficient cash is rejected", async ({ request }) => {
    const before = await getPortfolio(request);
    const res = await request.post("/api/portfolio/trade", {
      data: { ticker: "AAPL", side: "buy", quantity: 10_000_000 },
    });
    expect(res.status()).toBe(400);
    expect(typeof (await res.json()).detail).toBe("string");
    expect((await getPortfolio(request)).cash_balance).toBeCloseTo(before.cash_balance, 2);
  });

  test("selling more than held is rejected", async ({ request }) => {
    const held = await heldQuantity(request, "NFLX");
    const res = await request.post("/api/portfolio/trade", {
      data: { ticker: "NFLX", side: "sell", quantity: held + 5 },
    });
    expect(res.status()).toBe(400);
    expect(typeof (await res.json()).detail).toBe("string");
    expect(await heldQuantity(request, "NFLX")).toBeCloseTo(held, 4);
  });

  test("invalid trade input is rejected", async ({ request }) => {
    const bad = [
      { ticker: "not a ticker!", side: "buy", quantity: 1 },
      { ticker: "AAPL", side: "buy", quantity: 0 },
      { ticker: "AAPL", side: "buy", quantity: -1 },
      { ticker: "AAPL", side: "hold", quantity: 1 },
    ];
    for (const data of bad) {
      const res = await request.post("/api/portfolio/trade", { data });
      expect([400, 422], JSON.stringify(data)).toContain(res.status());
      expect(await res.json(), JSON.stringify(data)).toHaveProperty("detail");
    }
  });

  test("trading an unwatched ticker works without adding it to the watchlist", async ({ request }) => {
    const t = "ZZTEST";
    await ensureNotOnWatchlist(request, t);
    await closePosition(request, t);
    await ensureCash(request, 5000);

    const res = await trade(request, t, "buy", 1);
    expect(res.trade.ticker).toBe(t);
    expect(res.trade.price).toBeGreaterThan(0);
    expect((await getWatchlist(request)).map((w) => w.ticker)).not.toContain(t);
    expect(await heldQuantity(request, t)).toBeCloseTo(1, 4);

    await trade(request, t, "sell", 1);
    expect(await heldQuantity(request, t)).toBe(0);
  });

  test("GET /api/portfolio/history is oldest to newest", async ({ request }) => {
    const res = await request.get("/api/portfolio/history");
    expect(res.status()).toBe(200);
    const { snapshots } = await res.json();
    expect(Array.isArray(snapshots)).toBe(true);
    const times = snapshots.map((s: any) => Date.parse(s.recorded_at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

test.describe("watchlist", () => {
  test("GET /api/watchlist shape", async ({ request }) => {
    const items = await getWatchlist(request);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      for (const k of ["ticker", "price", "previous_price", "change", "change_percent", "direction", "timestamp"]) {
        expect(item, `${item.ticker}.${k}`).toHaveProperty(k);
      }
    }
  });

  test("add is 201 then idempotent 200, delete is 200 then 404", async ({ request }) => {
    const t = "PYPL";
    await ensureNotOnWatchlist(request, t);

    const add = await request.post("/api/watchlist", { data: { ticker: "pypl" } });
    expect(add.status(), await add.text()).toBe(201);
    expect((await add.json()).ticker).toBe(t);

    const again = await request.post("/api/watchlist", { data: { ticker: t } });
    expect(again.status()).toBe(200);
    expect((await again.json()).ticker).toBe(t);

    const tickers = (await getWatchlist(request)).map((w) => w.ticker);
    expect(tickers.filter((x) => x === t)).toHaveLength(1);
    await waitForPrice(request, t);

    const del = await request.delete(`/api/watchlist/${t}`);
    expect(del.status()).toBe(200);
    expect(await del.json()).toEqual({ removed: t });
    expect((await getWatchlist(request)).map((w) => w.ticker)).not.toContain(t);

    const delAgain = await request.delete(`/api/watchlist/${t}`);
    expect(delAgain.status()).toBe(404);
    expect(await delAgain.json()).toHaveProperty("detail");
  });

  test("invalid ticker is rejected", async ({ request }) => {
    const res = await request.post("/api/watchlist", { data: { ticker: "$$$" } });
    expect(res.status()).toBe(400);
    expect(await res.json()).toHaveProperty("detail");
  });
});

test.describe("chat (LLM_MOCK=true)", () => {
  test("buy command executes a trade", async ({ request }) => {
    await ensureCash(request, 1000);
    await waitForPrice(request, "AAPL");
    const before = await heldQuantity(request, "AAPL");

    const res = await request.post("/api/chat", { data: { message: "buy 1 AAPL" } });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("Buying 1 shares of AAPL.");
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]).toMatchObject({ ticker: "AAPL", side: "buy", status: "executed" });
    expect(body.trades[0].quantity).toBeCloseTo(1, 4);
    expect(typeof body.trades[0].price).toBe("number");
    expect(body.watchlist_changes).toEqual([]);
    expect(await heldQuantity(request, "AAPL")).toBeCloseTo(before + 1, 4);

    const sell = await request.post("/api/chat", { data: { message: "SELL 1 aapl" } });
    const sellBody = await sell.json();
    expect(sellBody.trades[0]).toMatchObject({ ticker: "AAPL", side: "sell", status: "executed" });
    expect(await heldQuantity(request, "AAPL")).toBeCloseTo(before, 4);
  });

  test("failed trade is reported, not thrown", async ({ request }) => {
    const res = await request.post("/api/chat", { data: { message: "buy 10000000 AAPL" } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0].status).toBe("failed");
    expect(typeof body.trades[0].error).toBe("string");
  });

  test("add / remove commands change the watchlist", async ({ request }) => {
    const t = "SHOP";
    await ensureNotOnWatchlist(request, t);

    const add = await (await request.post("/api/chat", { data: { message: `add ${t}` } })).json();
    expect(add.message).toBe(`Adding ${t} to your watchlist.`);
    expect(add.watchlist_changes[0]).toMatchObject({ ticker: t, action: "add", status: "executed" });
    expect((await getWatchlist(request)).map((w) => w.ticker)).toContain(t);

    const rm = await (await request.post("/api/chat", { data: { message: `remove ${t}` } })).json();
    expect(rm.message).toBe(`Removing ${t} from your watchlist.`);
    expect(rm.watchlist_changes[0]).toMatchObject({ ticker: t, action: "remove", status: "executed" });
    expect((await getWatchlist(request)).map((w) => w.ticker)).not.toContain(t);
  });

  test("other messages get the portfolio-value fallback", async ({ request }) => {
    const res = await request.post("/api/chat", { data: { message: "how am I doing?" } });
    const body = await res.json();
    expect(body.message).toMatch(
      /^This is a mock response from FinAlly\. Your portfolio is worth \$[\d,]+\.\d{2}\.$/,
    );
    expect(body.trades).toEqual([]);
    expect(body.watchlist_changes).toEqual([]);
  });

  test("empty message is rejected with 422", async ({ request }) => {
    const res = await request.post("/api/chat", { data: { message: "   " } });
    expect(res.status()).toBe(422);
  });

  test("GET /api/chat/history stores both sides with actions", async ({ request }) => {
    await ensureOnWatchlist(request, "AAPL");
    const marker = `hello history ${Date.now()}`;
    await request.post("/api/chat", { data: { message: marker } });
    const res = await request.get("/api/chat/history");
    expect(res.status()).toBe(200);
    const { messages } = await res.json();
    expect(messages.length).toBeLessThanOrEqual(50);
    const idx = messages.findIndex((m: any) => m.content === marker);
    expect(idx, "user message not stored").toBeGreaterThanOrEqual(0);
    expect(messages[idx].role).toBe("user");
    const reply = messages[idx + 1];
    expect(reply.role).toBe("assistant");
    for (const k of ["id", "created_at", "actions"]) expect(reply).toHaveProperty(k);
  });
});
