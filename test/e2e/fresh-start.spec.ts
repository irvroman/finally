import { expect, test } from "@playwright/test";
import { DEFAULT_TICKERS, FRESH_DB, getPortfolio, getWatchlist, parseMoney } from "../support/api";

// PLAN §12: "Fresh start: default watchlist appears, $10k balance shown, prices are streaming".
// The exact seed assertions only hold on a fresh DB, so they are gated by FRESH_DB=true.
// Without it, the test checks that the UI mirrors whatever the backend holds.

test.describe("fresh start", () => {
  test("default watchlist and $10k cash are shown", async ({ page, request }) => {
    const watchlist = (await getWatchlist(request)).map((w) => w.ticker);
    const portfolio = await getPortfolio(request);

    if (FRESH_DB) {
      expect(watchlist).toEqual(DEFAULT_TICKERS);
      expect(portfolio.cash_balance).toBe(10000);
      expect(portfolio.positions).toEqual([]);
      expect(portfolio.total_value).toBe(10000);
    }

    await page.goto("/");
    await expect(page.getByTestId("watchlist")).toBeVisible();
    for (const t of watchlist) {
      await expect(page.getByTestId(`watchlist-row-${t}`)).toBeVisible();
    }
    await expect(page.locator('[data-testid^="watchlist-row-"]')).toHaveCount(watchlist.length);

    const cash = page.getByTestId("header-cash");
    await expect(cash).toBeVisible();
    await expect
      .poll(async () => parseMoney(await cash.textContent()))
      .toBeCloseTo(portfolio.cash_balance, 0);
    if (FRESH_DB) {
      await expect(cash).toHaveText(/\$10,000\.00/);
      await expect(page.getByTestId("header-total-value")).toHaveText(/\$10,000\.00/);
    }
  });

  test("connection is live and prices stream", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected", {
      timeout: 15_000,
    });

    // Every watchlist row gets a numeric price.
    const rows = page.locator('[data-testid^="watchlist-row-"]');
    await expect(rows.first()).toBeVisible();
    const tickers = await rows.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-testid")!.replace("watchlist-row-", "")),
    );
    for (const t of tickers) {
      await expect(page.getByTestId(`price-${t}`)).toHaveText(/\d+\.\d{2}/, { timeout: 15_000 });
    }

    // Prices keep changing: at least one of the visible prices differs from its first value.
    const snapshot = async () =>
      Promise.all(tickers.map((t) => page.getByTestId(`price-${t}`).textContent()));
    const first = await snapshot();
    await expect
      .poll(async () => (await snapshot()).some((p, i) => p !== first[i]), { timeout: 15_000 })
      .toBe(true);
  });

  test("clicking a ticker selects it in the main chart", async ({ page }) => {
    await page.goto("/");
    const rows = page.locator('[data-testid^="watchlist-row-"]');
    await expect(rows.nth(1)).toBeVisible();
    const id = await rows.nth(1).getAttribute("data-testid");
    const ticker = id!.replace("watchlist-row-", "");
    await rows.nth(1).click();
    await expect(page.getByTestId("main-chart-ticker")).toContainText(ticker);
    await expect(page.getByTestId("main-chart")).toBeVisible();
  });
});
