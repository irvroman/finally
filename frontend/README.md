# FinAlly frontend

Next.js 16 (App Router) + TypeScript + Tailwind CSS v4, built as a static export and served by the FastAPI backend on the same origin.

## Commands

```bash
npm install          # or `npm ci` in Docker
npm run dev          # next dev on :3000, proxies /api/* to http://localhost:8000
npm run build        # static export to frontend/out/ (out/index.html)
npm test             # Vitest + React Testing Library, single run
npm run typecheck    # tsc --noEmit
```

- To point the dev proxy at a different backend, run `BACKEND_URL=http://localhost:8011 npm run dev`.
- The `/api/*` rewrite applies only when `NODE_ENV=development`, because rewrites don't work with `output: "export"`. `compress: false` is set so the dev proxy doesn't gzip-buffer the SSE stream.
- In production, copy `out/` to the backend's `STATIC_DIR` (default `backend/static`).

## Layout

```
src/app/                 layout, page, global CSS (theme tokens), icon
src/components/          Terminal (page shell + data loading), Header, Watchlist, Sparkline,
                         MainChart, TradeBar, Heatmap, PnlChart, PositionsTable, ChatPanel
src/hooks/               usePriceStream (one shared EventSource -> PriceStore), useFlash
src/lib/                 api client, PriceStore, live portfolio revaluation, formatting, chart theme
```

## Data flow

- `PriceStreamProvider` opens one `EventSource('/api/stream/prices')` and feeds a `PriceStore`. The store holds the latest prices, the first price seen for each ticker (the basis for the watchlist's session change %), and the history since page load (used by sparklines and the main chart). If the browser gives up reconnecting, the provider opens a new connection after 3s.
- The portfolio comes from `GET /api/portfolio`. It's refetched every 15s, after trades, and after chat actions. Between fetches it's revalued with streamed prices (`applyLivePrices`).
- The P&L chart uses `GET /api/portfolio/history`, refetched every 30s and after trades.
- Charts use `lightweight-charts` v5 (canvas). The treemap uses `d3-hierarchy` squarify, rendered as absolutely positioned divs.

The `data-testid` hooks the E2E tests rely on are listed in `planning/TEAM_CONTRACT.md` §5.
