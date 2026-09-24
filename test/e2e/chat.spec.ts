import { expect, Page, test } from "@playwright/test";
import { ensureCash, ensureNotOnWatchlist, heldQuantity, waitForPrice } from "../support/api";

// PLAN §12: "AI chat (mocked): send a message, receive a response, trade execution appears inline".
// Requires the app to run with LLM_MOCK=true (grammar in TEAM_CONTRACT §3.3).

/** Load the page and let any persisted chat history render before counting messages. */
async function openApp(page: Page) {
  const history = page
    .waitForResponse((r) => r.url().includes("/api/chat/history"), { timeout: 5_000 })
    .catch(() => null);
  await page.goto("/");
  await history;
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.waitForTimeout(300);
}

test.describe("AI chat (LLM_MOCK)", () => {
  test("'buy 1 AAPL' replies, shows an inline action, and opens the position", async ({ page, request }) => {
    await ensureCash(request, 1000);
    await waitForPrice(request, "AAPL");
    const before = await heldQuantity(request, "AAPL");

    await openApp(page);
    const panel = page.getByTestId("chat-panel");

    const userMsgs = panel.getByTestId("chat-message-user");
    const replies = panel.getByTestId("chat-message-assistant");
    const actions = panel.getByTestId("chat-action");
    const userCount = await userMsgs.count();
    const replyCount = await replies.count();
    const actionCount = await actions.count();

    await page.getByTestId("chat-input").fill("buy 1 AAPL");
    await page.getByTestId("chat-send").click();

    await expect(userMsgs).toHaveCount(userCount + 1);
    await expect(userMsgs.last()).toContainText("buy 1 AAPL");
    await expect(replies).toHaveCount(replyCount + 1);
    await expect(replies.last()).toContainText("Buying 1 shares of AAPL.");
    await expect(page.getByTestId("chat-loading")).toBeHidden();

    await expect(actions).toHaveCount(actionCount + 1);
    await expect(actions.last()).toContainText("AAPL");
    await expect(actions.last()).toHaveAttribute("data-status", "executed");

    await expect(page.getByTestId("position-row-AAPL")).toBeVisible();
    expect(await heldQuantity(request, "AAPL")).toBeCloseTo(before + 1, 4);
  });

  test("'add <TICKER>' adds a watchlist row via chat", async ({ page, request }) => {
    const t = "UBER";
    await ensureNotOnWatchlist(request, t);
    try {
      await openApp(page);
      await expect(page.getByTestId(`watchlist-row-${t}`)).toHaveCount(0);
      const replyCount = await page.getByTestId("chat-message-assistant").count();
      await page.getByTestId("chat-input").fill(`add ${t}`);
      await page.getByTestId("chat-send").click();

      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(replyCount + 1);
      await expect(page.getByTestId("chat-message-assistant").last()).toContainText(
        `Adding ${t} to your watchlist.`,
      );
      await expect(page.getByTestId("chat-action").last()).toContainText(t);
      await expect(page.getByTestId("chat-action").last()).toHaveAttribute("data-status", "executed");
      await expect(page.getByTestId(`watchlist-row-${t}`)).toBeVisible();
    } finally {
      await ensureNotOnWatchlist(request, t);
    }
  });

  test("shows a loading indicator while waiting", async ({ page }) => {
    await openApp(page);
    // Delay the chat response so the loading state is observable.
    await page.route("**/api/chat", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.getByTestId("chat-input").fill("hello");
    await page.getByTestId("chat-send").click();
    await expect(page.getByTestId("chat-loading")).toBeVisible();
    await expect(page.getByTestId("chat-message-assistant").last()).toContainText(
      /mock response from FinAlly/,
    );
    await expect(page.getByTestId("chat-loading")).toBeHidden();
  });
});
