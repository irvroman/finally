import { expect, test } from "@playwright/test";
import { ensureNotOnWatchlist, getWatchlist } from "../support/api";

// PLAN §12: "Add and remove a ticker from the watchlist".

const TICKER = "PYPL";

test.describe("watchlist management", () => {
  test.beforeEach(async ({ request }) => {
    await ensureNotOnWatchlist(request, TICKER);
  });

  test.afterEach(async ({ request }) => {
    await ensureNotOnWatchlist(request, TICKER);
  });

  test("add a ticker, see it stream, then remove it", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.getByTestId("watchlist")).toBeVisible();
    await expect(page.getByTestId(`watchlist-row-${TICKER}`)).toHaveCount(0);

    await page.getByTestId("watchlist-add-input").fill(TICKER.toLowerCase());
    await page.getByTestId("watchlist-add-button").click();

    const row = page.getByTestId(`watchlist-row-${TICKER}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`price-${TICKER}`)).toHaveText(/\d+\.\d{2}/, { timeout: 15_000 });
    expect((await getWatchlist(request)).map((w) => w.ticker)).toContain(TICKER);

    // Survives a reload (persisted server-side).
    await page.reload();
    await expect(row).toBeVisible();

    await page.getByTestId(`watchlist-remove-${TICKER}`).click();
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => (await getWatchlist(request)).map((w) => w.ticker))
      .not.toContain(TICKER);

    await page.reload();
    await expect(page.getByTestId("watchlist")).toBeVisible();
    await expect(row).toHaveCount(0);
  });
});
