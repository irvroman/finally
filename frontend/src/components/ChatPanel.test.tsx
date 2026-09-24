import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatResponse } from "@/lib/types";
import { ChatPanel, describeActions } from "./ChatPanel";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const history: ChatMessage[] = [
  { id: "1", role: "user", content: "hi", actions: null, created_at: "2026-01-01T00:00:00Z" },
  {
    id: "2",
    role: "assistant",
    content: "Bought it.",
    actions: {
      trades: [{ ticker: "AAPL", side: "buy", quantity: 2, status: "executed", price: 190 }],
      watchlist_changes: [],
    },
    created_at: "2026-01-01T00:00:01Z",
  },
];

describe("ChatPanel", () => {
  it("loads and renders history with inline action confirmations", async () => {
    render(<ChatPanel loadHistory={() => Promise.resolve(history)} send={vi.fn()} />);
    expect(await screen.findByText("Bought it.")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-message-user")).toHaveLength(1);
    expect(screen.getAllByTestId("chat-message-assistant")).toHaveLength(1);
    expect(screen.getByTestId("chat-action")).toHaveTextContent("Bought 2 AAPL at $190.00");
  });

  it("shows a loading indicator while waiting, then the reply and actions", async () => {
    const user = userEvent.setup();
    const reply = deferred<ChatResponse>();
    const send = vi.fn().mockReturnValue(reply.promise);
    const onActions = vi.fn();
    render(<ChatPanel loadHistory={() => Promise.resolve([])} send={send} onActions={onActions} />);

    await user.type(screen.getByTestId("chat-input"), "buy 5 NVDA");
    await user.click(screen.getByTestId("chat-send"));

    expect(send).toHaveBeenCalledWith("buy 5 NVDA");
    expect(screen.getByTestId("chat-message-user")).toHaveTextContent("buy 5 NVDA");
    expect(screen.getByTestId("chat-loading")).toBeInTheDocument();
    expect(screen.getByTestId("chat-input")).toHaveValue("");

    reply.resolve({
      message: "Buying 5 shares of NVDA.",
      trades: [{ ticker: "NVDA", side: "buy", quantity: 5, status: "executed", price: 800 }],
      watchlist_changes: [{ ticker: "NVDA", action: "add", status: "failed", error: "Already watched" }],
    });

    expect(await screen.findByText("Buying 5 shares of NVDA.")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-loading")).not.toBeInTheDocument();
    const actions = screen.getAllByTestId("chat-action");
    expect(actions).toHaveLength(2);
    expect(actions[0]).toHaveAttribute("data-status", "failed");
    expect(actions[1]).toHaveTextContent("Bought 5 NVDA at $800.00");
    expect(onActions).toHaveBeenCalledTimes(1);
  });

  it("does not trigger a refresh when nothing executed", async () => {
    const user = userEvent.setup();
    const onActions = vi.fn();
    const send = vi.fn().mockResolvedValue({ message: "Hello", trades: [], watchlist_changes: [] });
    render(<ChatPanel loadHistory={() => Promise.resolve([])} send={send} onActions={onActions} />);
    await user.type(screen.getByTestId("chat-input"), "hello{Enter}");
    await screen.findByText("Hello");
    expect(onActions).not.toHaveBeenCalled();
  });

  it("shows a request failure as an assistant error message", async () => {
    const user = userEvent.setup();
    const send = vi.fn().mockRejectedValue(new Error("Can't reach the server."));
    render(<ChatPanel loadHistory={() => Promise.resolve([])} send={send} />);
    await user.type(screen.getByTestId("chat-input"), "hi");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-message-assistant")).toHaveTextContent("Can't reach the server."),
    );
  });
});

describe("describeActions", () => {
  it("describes watchlist and failed trades", () => {
    const out = describeActions({
      watchlist_changes: [{ ticker: "PYPL", action: "remove", status: "executed" }],
      trades: [{ ticker: "TSLA", side: "sell", quantity: 1.5, status: "failed", error: "Insufficient shares" }],
    });
    expect(out.map((a) => a.text)).toEqual([
      "Removed PYPL from watchlist",
      "Couldn't sell 1.5 TSLA: Insufficient shares",
    ]);
  });

  it("handles null actions", () => {
    expect(describeActions(null)).toEqual([]);
  });
});
