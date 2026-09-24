"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { PriceStore, type PriceState } from "@/lib/priceStore";

const PriceStoreContext = createContext<PriceStore | null>(null);

const STREAM_URL = "/api/stream/prices";
const MANUAL_RETRY_MS = 3000;

/** Opens the one shared EventSource for the page and feeds the PriceStore. */
export function PriceStreamProvider({
  children,
  store: injected,
}: {
  children: React.ReactNode;
  store?: PriceStore;
}) {
  const [store] = useState(() => injected ?? new PriceStore());

  useEffect(() => {
    if (injected || typeof EventSource === "undefined") return;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      store.setStatus("reconnecting");
      es = new EventSource(STREAM_URL);
      es.onopen = () => store.setStatus("connected");
      es.onmessage = (event) => {
        try {
          store.ingest(JSON.parse(event.data));
          store.setStatus("connected");
        } catch {
          // Ignore malformed frames; the next event will carry the full state.
        }
      };
      es.onerror = () => {
        if (!es) return;
        if (es.readyState === EventSource.CLOSED) {
          // The browser gave up (e.g. non-200 response); retry ourselves.
          store.setStatus("disconnected");
          es.close();
          if (!disposed) retryTimer = setTimeout(connect, MANUAL_RETRY_MS);
        } else {
          store.setStatus("reconnecting");
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      es?.close();
    };
  }, [store, injected]);

  return <PriceStoreContext.Provider value={store}>{children}</PriceStoreContext.Provider>;
}

export function usePriceStore(): PriceStore {
  const store = useContext(PriceStoreContext);
  if (!store) throw new Error("usePriceStore must be used inside PriceStreamProvider");
  return store;
}

export function usePrices(): PriceState {
  const store = usePriceStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
