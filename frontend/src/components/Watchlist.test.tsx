import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PriceStore, type PriceState } from "@/lib/priceStore";
import type { PriceUpdate, WatchlistItem } from "@/lib/types";
import { FLASH_MS } from "@/hooks/useFlash";
import { Watchlist } from "./Watchlist";

const item = (ticker: string, price: number | null = null): WatchlistItem => ({
  ticker,
  price,
  previous_price: null,
  change: null,
  change_percent: null,
  direction: null,
  timestamp: null,
});

const tick = (ticker: string, price: number, timestamp: number): PriceUpdate => ({
  ticker,
  price,
  previous_price: price,
  timestamp,
  change: 0,
  change_percent: 0,
  direction: "flat",
});

function setup(prices: PriceState, overrides: Partial<Parameters<typeof Watchlist>[0]> = {}) {
  const props = {
    items: [item("AAPL", 190), item("MSFT", 420)],
    prices,
    selected: "AAPL",
    onSelect: vi.fn(),
    onAdd: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const utils = render(<Watchlist {...props} />);
  return { ...utils, props };
}

describe("Watchlist", () => {
  it("renders a row per ticker, preferring streamed prices", () => {
    const store = new PriceStore();
    store.ingest({ AAPL: tick("AAPL", 191.5, 1) });
    setup(store.getState());
    expect(screen.getByTestId("watchlist-row-AAPL")).toBeInTheDocument();
    expect(screen.getByTestId("price-AAPL")).toHaveTextContent("191.50");
    expect(screen.getByTestId("price-MSFT")).toHaveTextContent("420.00");
  });

  it("flashes green on an uptick and red on a downtick, then clears", () => {
    vi.useFakeTimers();
    try {
      const store = new PriceStore();
      store.ingest({ AAPL: tick("AAPL", 100, 1) });
      const { rerender, props } = setup(store.getState());
      expect(screen.getByTestId("price-AAPL")).not.toHaveAttribute("data-flash");

      store.ingest({ AAPL: tick("AAPL", 101, 2) });
      rerender(<Watchlist {...props} prices={store.getState()} />);
      expect(screen.getByTestId("price-AAPL")).toHaveAttribute("data-flash", "up");
      expect(screen.getByTestId("price-AAPL")).toHaveClass("flash-up");

      store.ingest({ AAPL: tick("AAPL", 99, 3) });
      rerender(<Watchlist {...props} prices={store.getState()} />);
      expect(screen.getByTestId("price-AAPL")).toHaveAttribute("data-flash", "down");

      act(() => {
        vi.advanceTimersByTime(FLASH_MS + 10);
      });
      expect(screen.getByTestId("price-AAPL")).not.toHaveAttribute("data-flash");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds an uppercased ticker and clears the input", async () => {
    const user = userEvent.setup();
    const { props } = setup(new PriceStore().getState());
    await user.type(screen.getByTestId("watchlist-add-input"), "pypl");
    await user.click(screen.getByTestId("watchlist-add-button"));
    expect(props.onAdd).toHaveBeenCalledWith("PYPL");
    expect(screen.getByTestId("watchlist-add-input")).toHaveValue("");
  });

  it("rejects invalid tickers without calling the API", async () => {
    const user = userEvent.setup();
    const { props } = setup(new PriceStore().getState());
    await user.type(screen.getByTestId("watchlist-add-input"), "1ABC");
    await user.click(screen.getByTestId("watchlist-add-button"));
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows the server error when adding fails", async () => {
    const user = userEvent.setup();
    setup(new PriceStore().getState(), {
      onAdd: vi.fn().mockRejectedValue(new Error("Invalid ticker")),
    });
    await user.type(screen.getByTestId("watchlist-add-input"), "ZZZ");
    await user.click(screen.getByTestId("watchlist-add-button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid ticker");
  });

  it("removes a ticker without selecting it", async () => {
    const user = userEvent.setup();
    const { props } = setup(new PriceStore().getState());
    await user.click(screen.getByTestId("watchlist-remove-MSFT"));
    expect(props.onRemove).toHaveBeenCalledWith("MSFT");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("selects a ticker when its row is clicked", async () => {
    const user = userEvent.setup();
    const { props } = setup(new PriceStore().getState());
    await user.click(screen.getByTestId("watchlist-row-MSFT"));
    expect(props.onSelect).toHaveBeenCalledWith("MSFT");
  });
});
