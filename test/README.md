# FinAlly E2E tests

Playwright (TypeScript) tests for the whole app: API contract tests and browser tests for every scenario in `planning/PLAN.md` §12. They target the `data-testid` hooks and the LLM mock grammar defined in `planning/TEAM_CONTRACT.md` (§5 and §3.3).

## Layout

| Path | What |
|---|---|
| `e2e/fresh-start.spec.ts` | Project `fresh`: default watchlist, $10k, live prices, ticker selection. Runs first. |
| `api/api.spec.ts` | Project `api`: REST shapes and status codes, SSE payload, and the mocked chat grammar. |
| `e2e/*.spec.ts` | Project `e2e`: watchlist add/remove, buy/sell, heatmap and P&L chart, mocked chat, SSE reconnect. |
| `support/api.ts` | Shared API helpers (portfolio/watchlist reads, trades, state setup). |
| `docker-compose.test.yml` | App container (LLM_MOCK, fresh tmpfs DB) plus a Playwright container. |

Projects run in order `fresh` → `api` → `e2e` with one worker, because they share a single-user database.

## The app must run with `LLM_MOCK=true`

The chat tests depend on the deterministic mock responses.

## State and `FRESH_DB`

Tests measure deltas and set up their own preconditions through the API (for example, liquidating positions when cash runs low), so they pass against a database that already holds data. The exact seed checks (10 default tickers, $10,000.00 cash, no positions) run only when `FRESH_DB=true`, which you should set only when the app started from an empty DB.

## Run against a local app

From `backend/` (Git Bash):

```bash
export PATH="$HOME/.local/bin:$PATH"
LLM_MOCK=true DB_PATH=/tmp/finally-e2e.db STATIC_DIR=../frontend/out \
  uv run uvicorn app.main:app --port 8000
```

Build the frontend first (`cd frontend && npm run build`) so `frontend/out` exists. Then, from `test/`:

```bash
npm install
npx playwright install chromium
FRESH_DB=true npx playwright test          # all projects
npx playwright test --project=api          # API only (also runs "fresh" as a dependency)
BASE_URL=http://localhost:9000 npx playwright test   # different host/port
npx playwright show-report                 # HTML report after a run
```

Delete the DB file before each run if you want `FRESH_DB=true` to hold.

## Run in Docker

From the repo root:

```bash
docker compose -f test/docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from playwright
docker compose -f test/docker-compose.test.yml down -v
```

The app uses a tmpfs DB, so every run starts fresh and `FRESH_DB=true` is set for the Playwright container. The report is written to `test/playwright-report/`.
