import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Trade } from "@/lib/types";
import { TradeBar } from "./TradeBar";

const trade = (over: Partial<Trade> = {}): Trade => ({
  id: "t1",
  ticker: "AAPL",
  side: "buy",
  quantity: 2.5,
  price: 190.123,
  executed_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("TradeBar", () => {
  it("pre-fills the selected ticker and submits a fractional buy", async () => {
    const user = userEvent.setup();
    const onTrade = vi.fn().mockResolvedValue(trade());
    render(<TradeBar selectedTicker="AAPL" cash={10000} onTrade={onTrade} />);
    expect(screen.getByTestId("trade-ticker")).toHaveValue("AAPL");
    await user.type(screen.getByTestId("trade-quantity"), "2.5");
    await user.click(screen.getByTestId("trade-buy"));
    expect(onTrade).toHaveBeenCalledWith("AAPL", 2.5, "buy");
    expect(await screen.findByText("Bought 2.5 AAPL at $190.12.")).toBeInTheDocument();
  });

  it("shows the backend error for a failed sell", async () => {
    const user = userEvent.setup();
    const onTrade = vi.fn().mockRejectedValue(new Error("Insufficient shares"));
    render(<TradeBar selectedTicker="TSLA" cash={10000} onTrade={onTrade} />);
    await user.type(screen.getByTestId("trade-quantity"), "3");
    await user.click(screen.getByTestId("trade-sell"));
    expect(onTrade).toHaveBeenCalledWith("TSLA", 3, "sell");
    expect(await screen.findByTestId("trade-message")).toHaveTextContent("Insufficient shares");
    expect(screen.getByTestId("trade-message")).toHaveAttribute("data-kind", "error");
  });

  it("validates quantity before calling the API", async () => {
    const user = userEvent.setup();
    const onTrade = vi.fn();
    render(<TradeBar selectedTicker="AAPL" cash={10000} onTrade={onTrade} />);
    await user.click(screen.getByTestId("trade-buy"));
    expect(onTrade).not.toHaveBeenCalled();
    expect(screen.getByTestId("trade-message")).toHaveTextContent("greater than 0");
  });
});
