import { expect, Page, test } from "@playwright/test";
import {
  closePosition,
  ensureCash,
  heldQuantity,
  parseMoney,
  trade,
  waitForPrice,
} from "../support/api";

// PLAN §12: "Buy shares: cash decreases, position appears, portfolio updates" and
// "Sell shares: cash increases, position updates or disappears".

async function headerCash(page: Page) {
  return parseMoney(await page.getByTestId("header-cash").textContent());
}

async function submitTrade(page: Page, ticker: string, qty: number, side: "buy" | "sell") {
  await page.getByTestId("trade-ticker").fill(ticker);
  await page.getByTestId("trade-quantity").fill(String(qty));
  await page.getByTestId(side === "buy" ? "trade-buy" : "trade-sell").click();
}

async function loaded(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("header-cash")).toHaveText(/\$[\d,]+\.\d{2}/);
}

test.describe("trading via the trade bar", () => {
  test("buy shares: cash decreases and position appears", async ({ page, request }) => {
    const t = "AMZN";
    await ensureCash(request, 2000);
    await closePosition(request, t);
    await waitForPrice(request, t);

    await loaded(page);
    const cashBefore = await headerCash(page);
    await expect(page.getByTestId(`position-row-${t}`)).toHaveCount(0);

    await submitTrade(page, t, 3, "buy");

    await expect(page.getByTestId("trade-message")).toBeVisible();
    await expect(page.getByTestId("trade-message")).toHaveAttribute("data-kind", "ok");
    await expect(page.getByTestId(`position-row-${t}`)).toBeVisible();
    await expect(page.getByTestId("positions-table")).toContainText(t);
    await expect.poll(() => headerCash(page)).toBeLessThan(cashBefore - 1);
    expect(await heldQuantity(request, t)).toBeCloseTo(3, 4);

    // UI cash matches the backend.
    const apiCash = (await (await request.get("/api/portfolio")).json()).cash_balance;
    await expect.poll(() => headerCash(page)).toBeCloseTo(apiCash, 1);
  });

  test("sell shares: cash increases, position shrinks then disappears", async ({ page, request }) => {
    const t = "NVDA";
    await ensureCash(request, 3000);
    await closePosition(request, t);
    await waitForPrice(request, t);
    await trade(request, t, "buy", 2);

    await loaded(page);
    const row = page.getByTestId(`position-row-${t}`);
    await expect(row).toBeVisible();
    const cashBefore = await headerCash(page);

    await submitTrade(page, t, 1, "sell");
    await expect(page.getByTestId("trade-message")).toHaveAttribute("data-kind", "ok");
    await expect.poll(() => headerCash(page)).toBeGreaterThan(cashBefore + 1);
    await expect.poll(() => heldQuantity(request, t)).toBeCloseTo(1, 4);
    await expect(row).toBeVisible();

    const cashMid = await headerCash(page);
    await submitTrade(page, t, 1, "sell");
    await expect(row).toHaveCount(0);
    await expect.poll(() => headerCash(page)).toBeGreaterThan(cashMid + 1);
    expect(await heldQuantity(request, t)).toBe(0);
  });

  test("rejected trade shows an error and changes nothing", async ({ page, request }) => {
    const t = "TSLA";
    await waitForPrice(request, t);
    const held = await heldQuantity(request, t);

    await loaded(page);
    const cashBefore = await headerCash(page);
    await submitTrade(page, t, held + 1000, "sell");

    await expect(page.getByTestId("trade-message")).toBeVisible();
    await expect(page.getByTestId("trade-message")).toHaveAttribute("data-kind", "error");
    await expect(page.getByTestId("trade-message")).toContainText(/.+/);
    expect(await heldQuantity(request, t)).toBeCloseTo(held, 4);
    expect(await headerCash(page)).toBeCloseTo(cashBefore, 2);
  });
});
