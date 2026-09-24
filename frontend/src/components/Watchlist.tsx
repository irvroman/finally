"use client";

import { useState } from "react";
import type { WatchlistItem } from "@/lib/types";
import { sessionChangePercent, type PriceState } from "@/lib/priceStore";
import { formatPercent, formatPrice, signClass } from "@/lib/format";
import { useFlash } from "@/hooks/useFlash";
import { Panel } from "./Panel";
import { Sparkline } from "./Sparkline";

export const TICKER_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export function Watchlist({
  items,
  prices,
  selected,
  onSelect,
  onAdd,
  onRemove,
}: {
  items: WatchlistItem[];
  prices: PriceState;
  selected: string | null;
  onSelect: (ticker: string) => void;
  onAdd: (ticker: string) => Promise<void>;
  onRemove: (ticker: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ticker = draft.trim().toUpperCase();
    if (!ticker) return;
    if (!TICKER_RE.test(ticker)) {
      setError("Use 1–10 letters, digits or dots, starting with a letter.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onAdd(ticker);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that ticker.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ticker: string) => {
    setError(null);
    try {
      await onRemove(ticker);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't remove ${ticker}.`);
    }
  };

  return (
    <Panel
      title="Watchlist"
      aside={<span className="num text-[11px] text-faint">{items.length} symbols</span>}
      testId="watchlist"
      className="h-full"
      bodyClassName="flex flex-col"
    >
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 border-b border-line px-3 py-1 text-[11px] text-faint">
        <span>Symbol</span>
        <span className="w-[72px]">Session</span>
        <span className="w-[76px] text-right">Last</span>
        <span className="w-4" />
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Watched tickers">
        {items.map((item) => (
          <WatchlistRow
            key={item.ticker}
            ticker={item.ticker}
            fallbackPrice={item.price}
            prices={prices}
            selected={selected === item.ticker}
            onSelect={onSelect}
            onRemove={remove}
          />
        ))}
        {items.length === 0 && (
          <li className="px-3 py-6 text-center text-muted">
            Your watchlist is empty. Add a symbol below to start streaming it.
          </li>
        )}
      </ul>
      <form onSubmit={submit} className="shrink-0 border-t border-line p-2">
        <div className="flex gap-1.5">
          <input
            data-testid="watchlist-add-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            placeholder="Add symbol, e.g. PYPL"
            aria-label="Ticker to add"
            maxLength={10}
            className="num h-8 min-w-0 flex-1 border border-line bg-bg px-2 text-ink placeholder:text-faint focus:border-blue focus:outline-none"
          />
          <button
            data-testid="watchlist-add-button"
            type="submit"
            disabled={busy || !draft.trim()}
            className="h-8 border border-blue px-3 font-medium text-blue hover:bg-blue hover:text-bg disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-1.5 text-[12px] text-down">
            {error}
          </p>
        )}
      </form>
    </Panel>
  );
}

function WatchlistRow({
  ticker,
  fallbackPrice,
  prices,
  selected,
  onSelect,
  onRemove,
}: {
  ticker: string;
  fallbackPrice: number | null;
  prices: PriceState;
  selected: boolean;
  onSelect: (ticker: string) => void;
  onRemove: (ticker: string) => void;
}) {
  const price = prices.prices[ticker]?.price ?? fallbackPrice;
  const change = sessionChangePercent(prices, ticker);
  const flash = useFlash(price);

  return (
    <li
      data-testid={`watchlist-row-${ticker}`}
      aria-selected={selected}
      onClick={() => onSelect(ticker)}
      className={`group grid cursor-pointer grid-cols-[1fr_auto_auto_auto] items-center gap-x-3 border-b border-line/60 border-l-2 py-1.5 pr-3 pl-[10px] ${
        selected ? "border-l-accent bg-raised" : "border-l-transparent hover:bg-raised/60"
      }`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(ticker);
        }}
        className="flex min-w-0 flex-col items-start text-left"
      >
        <span className={`font-semibold ${selected ? "text-accent" : "text-ink"}`}>{ticker}</span>
        <span className={`num text-[11px] ${signClass(change)}`}>{formatPercent(change)}</span>
      </button>
      <Sparkline points={prices.history[ticker]} />
      <span
        key={flash.seq}
        data-testid={`price-${ticker}`}
        data-flash={flash.dir ?? undefined}
        className={`num w-[76px] px-1 py-0.5 text-right text-[14px] font-medium text-ink ${
          flash.dir ? `flash-${flash.dir}` : ""
        }`}
      >
        {formatPrice(price)}
      </span>
      <button
        type="button"
        data-testid={`watchlist-remove-${ticker}`}
        aria-label={`Remove ${ticker} from watchlist`}
        title={`Remove ${ticker}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(ticker);
        }}
        className="w-4 text-[15px] leading-none text-faint opacity-50 group-hover:opacity-100 hover:text-down focus-visible:opacity-100"
      >
        ×
      </button>
    </li>
  );
}
