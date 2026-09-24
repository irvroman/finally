"use client";

import { useEffect, useState } from "react";
import type { Trade } from "@/lib/types";
import { formatPrice, formatQuantity, formatUsd } from "@/lib/format";
import { TICKER_RE } from "./Watchlist";

type Side = "buy" | "sell";

export function TradeBar({
  selectedTicker,
  cash,
  onTrade,
}: {
  selectedTicker: string | null;
  cash: number | null;
  onTrade: (ticker: string, quantity: number, side: Side) => Promise<Trade>;
}) {
  const [ticker, setTicker] = useState(selectedTicker ?? "");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState<Side | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Selecting a symbol elsewhere pre-fills the ticker field.
  useEffect(() => {
    if (selectedTicker) setTicker(selectedTicker);
  }, [selectedTicker]);

  const submit = async (side: Side) => {
    const t = ticker.trim().toUpperCase();
    const q = Number(quantity);
    if (!TICKER_RE.test(t)) {
      setMessage({ kind: "error", text: "Enter a valid symbol, e.g. AAPL." });
      return;
    }
    if (!quantity.trim() || !Number.isFinite(q) || q <= 0) {
      setMessage({ kind: "error", text: "Enter a quantity greater than 0." });
      return;
    }
    setBusy(side);
    setMessage(null);
    try {
      const trade = await onTrade(t, Math.round(q * 10000) / 10000, side);
      const verb = trade.side === "buy" ? "Bought" : "Sold";
      setMessage({
        kind: "ok",
        text: `${verb} ${formatQuantity(trade.quantity)} ${trade.ticker} at $${formatPrice(trade.price)}.`,
      });
      setQuantity("");
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Trade failed." });
    } finally {
      setBusy(null);
    }
  };

  const field =
    "num h-8 w-24 border border-line bg-bg px-2 text-ink placeholder:text-faint focus:border-blue focus:outline-none";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit("buy");
      }}
      className="flex flex-wrap items-center gap-2 border border-line bg-panel px-3 py-2"
      aria-label="Place a market order"
    >
      <span className="mr-1 text-[12px] font-semibold text-muted">Market order</span>
      <input
        data-testid="trade-ticker"
        aria-label="Symbol"
        value={ticker}
        onChange={(e) => setTicker(e.target.value.toUpperCase())}
        placeholder="Symbol"
        maxLength={10}
        className={`${field} font-semibold`}
      />
      <input
        data-testid="trade-quantity"
        aria-label="Quantity"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        placeholder="Qty"
        inputMode="decimal"
        type="number"
        min="0"
        step="any"
        className={`${field} [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none`}
      />
      <button
        data-testid="trade-buy"
        type="button"
        disabled={busy !== null}
        onClick={() => submit("buy")}
        className="h-8 min-w-16 bg-purple px-4 font-semibold text-white hover:bg-purple-hover disabled:opacity-50"
      >
        {busy === "buy" ? "Buying…" : "Buy"}
      </button>
      <button
        data-testid="trade-sell"
        type="button"
        disabled={busy !== null}
        onClick={() => submit("sell")}
        className="h-8 min-w-16 border border-purple px-4 font-semibold text-ink hover:bg-purple/30 disabled:opacity-50"
      >
        {busy === "sell" ? "Selling…" : "Sell"}
      </button>
      <span className="num ml-1 text-[12px] text-faint">Cash available {formatUsd(cash)}</span>
      <p
        data-testid="trade-message"
        role="status"
        aria-live="polite"
        data-kind={message?.kind}
        className={`ml-auto min-h-[1em] text-[12px] ${message?.kind === "error" ? "text-down" : "text-up"}`}
      >
        {message?.text}
      </p>
    </form>
  );
}
