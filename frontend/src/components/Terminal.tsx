"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { applyLivePrices } from "@/lib/portfolio";
import { sessionChangePercent } from "@/lib/priceStore";
import type { Portfolio, Snapshot, WatchlistItem } from "@/lib/types";
import { PriceStreamProvider, usePrices } from "@/hooks/usePriceStream";
import { Header } from "./Header";
import { Watchlist } from "./Watchlist";
import { MainChart } from "./MainChart";
import { TradeBar } from "./TradeBar";
import { PositionsTable } from "./PositionsTable";
import { Heatmap } from "./Heatmap";
import { PnlChart } from "./PnlChart";
import { ChatPanel } from "./ChatPanel";

const PORTFOLIO_POLL_MS = 15_000;
const HISTORY_POLL_MS = 30_000;

export function Terminal() {
  return (
    <PriceStreamProvider>
      <Workstation />
    </PriceStreamProvider>
  );
}

function Workstation() {
  const prices = usePrices();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshWatchlist = useCallback(
    () => api.getWatchlist().then(setWatchlist, (e: Error) => setLoadError(e.message)),
    [],
  );
  const refreshPortfolio = useCallback(
    () =>
      api.getPortfolio().then(
        (p) => {
          setPortfolio(p);
          setLoadError(null);
        },
        (e: Error) => setLoadError(e.message),
      ),
    [],
  );
  const refreshHistory = useCallback(
    () => api.getHistory().then(setSnapshots, () => {}),
    [],
  );

  useEffect(() => {
    refreshWatchlist();
    refreshPortfolio();
    refreshHistory();
    const p = setInterval(refreshPortfolio, PORTFOLIO_POLL_MS);
    const h = setInterval(refreshHistory, HISTORY_POLL_MS);
    return () => {
      clearInterval(p);
      clearInterval(h);
    };
  }, [refreshWatchlist, refreshPortfolio, refreshHistory]);

  // Keep a valid selection: default to the first watched symbol.
  useEffect(() => {
    if (selected === null && watchlist.length) setSelected(watchlist[0].ticker);
  }, [watchlist, selected]);

  const live = useMemo(
    () => (portfolio ? applyLivePrices(portfolio, prices.prices) : null),
    [portfolio, prices.prices],
  );

  const addTicker = useCallback(async (ticker: string) => {
    const item = await api.addToWatchlist(ticker);
    setWatchlist((w) => (w.some((x) => x.ticker === item.ticker) ? w : [...w, item]));
  }, []);

  const removeTicker = useCallback(async (ticker: string) => {
    await api.removeFromWatchlist(ticker);
    setWatchlist((w) => w.filter((x) => x.ticker !== ticker));
    // The effect above then falls back to the first remaining symbol.
    setSelected((s) => (s === ticker ? null : s));
  }, []);

  const trade = useCallback(
    async (ticker: string, quantity: number, side: "buy" | "sell") => {
      const res = await api.trade(ticker, quantity, side);
      setPortfolio(res.portfolio);
      refreshHistory();
      return res.trade;
    },
    [refreshHistory],
  );

  const onChatActions = useCallback(() => {
    refreshPortfolio();
    refreshWatchlist();
    refreshHistory();
  }, [refreshPortfolio, refreshWatchlist, refreshHistory]);

  const selectedPrice = selected
    ? (prices.prices[selected]?.price ??
      watchlist.find((w) => w.ticker === selected)?.price ??
      null)
    : null;

  return (
    <div className="flex min-h-dvh flex-col bg-bg lg:h-dvh lg:min-h-0">
      <Header
        portfolio={live}
        status={prices.status}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((o) => !o)}
      />
      {loadError && (
        <p role="alert" className="border-b border-down/40 bg-down/10 px-4 py-1 text-[12px] text-down">
          {loadError}
        </p>
      )}

      <main
        className={`grid flex-1 gap-1 p-1 lg:min-h-0 lg:overflow-hidden ${
          chatOpen
            ? "grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_340px]"
            : "grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_36px]"
        }`}
      >
        <div className="h-[420px] min-h-0 lg:h-auto">
          <Watchlist
            items={watchlist}
            prices={prices}
            selected={selected}
            onSelect={setSelected}
            onAdd={addTicker}
            onRemove={removeTicker}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-1 lg:min-h-0">
          <div className="h-[340px] min-h-[220px] lg:h-auto lg:flex-[1.25]">
            <MainChart
              ticker={selected}
              points={selected ? prices.history[selected] : undefined}
              price={selectedPrice}
              change={selected ? sessionChangePercent(prices, selected) : null}
            />
          </div>
          <TradeBar selectedTicker={selected} cash={live?.cash_balance ?? null} onTrade={trade} />
          <div className="grid grid-cols-1 gap-1 md:grid-cols-2 lg:min-h-0 lg:flex-1">
            <div className="h-[240px] min-h-0 lg:h-auto">
              <Heatmap positions={live?.positions ?? []} onSelect={setSelected} />
            </div>
            <div className="h-[240px] min-h-0 lg:h-auto">
              <PnlChart snapshots={snapshots} />
            </div>
          </div>
          <div className="h-[220px] min-h-0 lg:h-auto lg:flex-[0.8]">
            <PositionsTable positions={live?.positions ?? []} onSelect={setSelected} />
          </div>
        </div>

        {chatOpen ? (
          <div className="h-[520px] min-h-0 lg:h-auto">
            <ChatPanel
              loadHistory={api.getChatHistory}
              send={api.sendChat}
              onActions={onChatActions}
              onCollapse={() => setChatOpen(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setChatOpen(true)}
            aria-label="Open assistant"
            className="hidden border border-line bg-panel text-[12px] font-medium text-muted hover:text-blue lg:block"
          >
            <span className="inline-block -rotate-90 whitespace-nowrap">Assistant</span>
          </button>
        )}
      </main>
    </div>
  );
}
