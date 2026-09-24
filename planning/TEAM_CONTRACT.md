# FinAlly — Team Contract

This is the binding contract between team members building the app. `PLAN.md` holds the vision; this file holds the **decisions and interfaces** that let everyone work in parallel. If you need to change anything here, message the team lead first. Do not silently diverge.

## 0. Team, ownership, rules

| Member (agent name) | Owns (only this member edits these paths) |
|---|---|
| `db-engineer` | `backend/app/db/**`, `backend/tests/db/**` |
| `backend-engineer` | `backend/app/main.py`, `backend/app/api/**`, `backend/app/services/**`, `backend/tests/api/**`, `backend/tests/services/**`, `backend/pyproject.toml`, `backend/uv.lock`, `backend/CLAUDE.md` |
| `llm-engineer` | `backend/app/llm/**`, `backend/tests/llm/**` |
| `frontend-engineer` | `frontend/**` |
| `devops-engineer` | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `scripts/**`, `.env.example`, `db/.gitkeep`, `.gitignore`, `README.md` |
| `integration-tester` | `test/**` |

`backend/app/market/**` is finished. Do not modify it without asking the lead.

**Rules**
- Everyone shares one working tree. **Never edit a file you don't own.** If you need a change in someone else's file, SendMessage the owner with the exact change.
- **No git commits, pushes, branch switches, stashes, or resets.** The lead handles git.
- Need a new Python dependency? Ask `backend-engineer` (they own `pyproject.toml`/`uv.lock`). Already added: `fastapi`, `uvicorn`, `litellm`, `pydantic`, `python-dotenv`, `httpx` (dev), `pytest`, `pytest-asyncio`.
- On this Windows machine `uv` lives at `~/.local/bin/uv.exe`. In Bash, prefix with `export PATH="$HOME/.local/bin:$PATH"`.
- Backend tests: `cd backend && uv run --extra dev pytest`. Lint: `uv run --extra dev ruff check app tests`.
- Write unit tests for your own code. When you finish a milestone, message the lead with a short status that lists what works, the test counts, and any open items.

## 1. Product decisions (resolves PLAN.md §13 gaps)

1. **Tracked tickers = watchlist ∪ tickers with open positions.** The market data source tracks this union.
   - Removing a ticker from the watchlist is always allowed. It stays tracked by the source if a position is open.
   - When a sell takes a position to zero, the `positions` row is **deleted**. If the ticker is also not on the watchlist, it is removed from the source.
2. **Trading an unwatched ticker is allowed.** The trade service calls `source.add_ticker(t)` if `t` isn't tracked. The simulator seeds a price immediately. If there's still no cached price, the service returns 400 `"No price available for {t}"`. The ticker is **not** added to the watchlist automatically.
3. **Ticker validation.** Uppercase and strip the input, then match `^[A-Z][A-Z0-9.]{0,9}$`. Anything else returns 400. The simulator accepts any valid symbol (unknown symbols get a random seed price).
4. **Fractional shares are allowed.** Quantity must be `> 0`. Round to 4 decimal places on input. Prices and cash are rounded to 2 decimal places in API output only; store full precision.
5. **Buy validation:** `quantity * price <= cash`. **Sell validation:** `quantity <= held` (with a 1e-9 tolerance; selling the full position deletes the row). Average cost updates on buys only: `new_avg = (old_qty*old_avg + qty*price) / (old_qty+qty)`.
6. **Portfolio snapshots** are recorded every 30s by a background task and immediately after every successful trade. `total_value = cash + Σ qty * current_price`. If a ticker has no price, fall back to `avg_cost`.
7. **SQLite runs in WAL mode.** Each operation opens a short-lived `sqlite3` connection with `PRAGMA journal_mode=WAL` and `busy_timeout=5000`. A trade (cash + position + trade row) is **one transaction**.
8. **SSE stream (already built):** `GET /api/stream/prices`. It checks every 500ms and pushes only when the cache version changes. Each event is `data: {"AAPL": {"ticker","price","previous_price","timestamp","change","change_percent","direction"}, ...}` and contains *all* tracked tickers. `timestamp` is unix seconds (float).
9. **Daily change % in the watchlist** is computed on the frontend as the change from the first price seen since page load. The simulator has no real "open" price.
10. **Chat history sent to the LLM** is capped at the last 20 messages. The LLM call has a 30s timeout.
11. **LLM failure:** `/api/chat` returns HTTP 200 with `{"message": "Sorry — I couldn't reach the AI service right now. Please try again.", "trades": [], "watchlist_changes": [], "error": "<short reason>"}`. The user message is still stored. The error reply is not stored.
12. **LLM action order:** apply `watchlist_changes` first, then `trades`. Each action runs independently, so one failure doesn't stop the others.
13. **Charting:** use `lightweight-charts` (canvas) for the main price chart and the P&L chart. Sparklines are small inline SVG or canvas you write yourself. The treemap is built with `d3-hierarchy` (`treemap().tile(treemapSquarify)`) and rendered as absolutely-positioned divs.
14. `user_id` is kept in every table (always `"default"`) for future multi-user support. Don't remove it.

## 2. Runtime layout / env

- `DB_PATH` env var sets the SQLite file. The default is `<repo-root>/db/finally.db`, resolved relative to `backend/app/db/` as `Path(__file__).resolve().parents[3] / "db" / "finally.db"`. Create the parent dir if it's missing. In Docker it's `/app/db/finally.db`.
- `STATIC_DIR` env var sets where the Next.js export is served from. The default is `backend/static`. `main.py` mounts it at `/` with `html=True` **only if the dir exists**, and **after** all `/api` routes.
- `.env` is loaded from the repo root via `python-dotenv` in `main.py` (`load_dotenv(find_dotenv())` or an explicit path). Variables: `OPENROUTER_API_KEY`, `MASSIVE_API_KEY`, `LLM_MOCK`.
- Docker: `WORKDIR /app`. The backend lives at `/app/backend` and static files at `/app/backend/static`. Volume `finally-data:/app/db`. Run with `uvicorn app.main:app --host 0.0.0.0 --port 8000` from `/app/backend`.
- Frontend dev: `next dev` on :3000 proxies `/api/*` to `http://localhost:8000` through `rewrites()` in `next.config`, applied **only in development**. Rewrites are incompatible with `output: 'export'`, so guard them with `process.env.NODE_ENV`. The production build is `output: 'export'`, which writes to `frontend/out/`.

## 3. Backend module interfaces

### 3.1 `app/db` (db-engineer). Synchronous `sqlite3`, plain dicts in and out.

```python
# app/db/__init__.py re-exports everything below
def init_db(db_path: str | Path | None = None) -> None      # idempotent: create tables + seed if empty
def get_db_path() -> Path                                    # honours DB_PATH at call time
class InsufficientFunds(Exception): ...
class InsufficientShares(Exception): ...

def get_cash(user_id="default") -> float
def get_watchlist(user_id="default") -> list[str]            # ordered by added_at
def add_to_watchlist(ticker, user_id="default") -> bool      # False if already present
def remove_from_watchlist(ticker, user_id="default") -> bool # False if absent
def get_positions(user_id="default") -> list[dict]           # {ticker, quantity, avg_cost, updated_at}
def get_position(ticker, user_id="default") -> dict | None
def apply_trade(ticker, side, quantity, price, user_id="default") -> dict
    # ONE transaction: validate (raise InsufficientFunds/InsufficientShares/ValueError),
    # update cash, upsert/delete position, insert trade row.
    # returns trade row {id, ticker, side, quantity, price, executed_at}
def get_trades(limit=50, user_id="default") -> list[dict]
def record_snapshot(total_value, user_id="default") -> dict  # {id, total_value, recorded_at}
def get_snapshots(limit=500, user_id="default") -> list[dict]  # oldest→newest
def add_chat_message(role, content, actions: dict | None = None, user_id="default") -> dict
def get_chat_messages(limit=20, user_id="default") -> list[dict]  # oldest→newest, actions parsed from JSON
```
Timestamps are ISO-8601 UTC strings (`datetime.now(timezone.utc).isoformat()`). Tests use a `tmp_path` DB through `DB_PATH` or `init_db(path)`.

### 3.2 `app/services` (backend-engineer): the trading service used by the REST API **and** the LLM

```python
class TradeError(Exception): ...           # message is user-facing (400 detail / chat error)

class TradingService:
    def __init__(self, price_cache: PriceCache, source: MarketDataSource): ...
    async def execute_trade(self, ticker: str, side: str, quantity: float) -> dict   # trade row; raises TradeError
    async def add_to_watchlist(self, ticker: str) -> dict        # watchlist item (shape below); raises TradeError on invalid ticker
    async def remove_from_watchlist(self, ticker: str) -> bool   # False if not present
    def get_portfolio(self) -> dict                              # shape of GET /api/portfolio
    def get_watchlist(self) -> list[dict]                        # shape of GET /api/watchlist items
    def get_history(self) -> list[dict]
    async def record_snapshot(self) -> dict
```
`main.py` builds one `PriceCache`, one source, and one `TradingService` in the FastAPI lifespan. It starts the source with watchlist ∪ positions, starts the 30s snapshot task, and stores everything on `app.state`.

### 3.3 `app/llm` (llm-engineer)

```python
# app/llm/schemas.py : pydantic LLMResponse {message: str, trades: list[TradeAction]=[], watchlist_changes: list[WatchlistAction]=[]}
# app/llm/chat.py
async def handle_chat(user_message: str, service: TradingService) -> dict   # returns POST /api/chat response body
# app/llm/router.py
def create_chat_router(get_service: Callable[[], TradingService]) -> APIRouter  # POST /api/chat, GET /api/chat/history
```
Use the **cerebras** skill (`.claude/skills/cerebras/SKILL.md`): `litellm.completion`, model `openrouter/openai/gpt-oss-120b`, `extra_body={"provider":{"order":["cerebras"]}}`, `reasoning_effort="low"`, and `response_format=LLMResponse`. `completion` is sync, so run it with `asyncio.to_thread`. `backend-engineer` mounts the router in `main.py`.

**Mock mode (`LLM_MOCK=true`) grammar.** This is deterministic, and the E2E tests rely on it. Match case-insensitively, first rule wins:
- `buy <qty> <TICKER>` → message `"Buying <qty> shares of <TICKER>."` + trade buy
- `sell <qty> <TICKER>` → message `"Selling <qty> shares of <TICKER>."` + trade sell
- `add <TICKER>` / `watch <TICKER>` → message `"Adding <TICKER> to your watchlist."` + watchlist add
- `remove <TICKER>` → message `"Removing <TICKER> from your watchlist."` + watchlist remove
- anything else → `"This is a mock response from FinAlly. Your portfolio is worth $<total_value>."` (2dp, no actions)

## 4. REST API (backend-engineer implements routes; frontend and tests consume them)

Errors are always `{"detail": "<message>"}` with status 400, 404, or 422.

| Method/Path | Request | Response |
|---|---|---|
| `GET /api/health` | – | `{"status":"ok"}` |
| `GET /api/portfolio` | – | `{cash_balance, total_value, positions_value, unrealized_pnl, positions:[{ticker, quantity, avg_cost, current_price, market_value, unrealized_pnl, pnl_percent, weight}]}` (`weight` = market_value/total_value, 0..1; `pnl_percent` in percent units, e.g. 5.2) |
| `POST /api/portfolio/trade` | `{ticker, quantity, side:"buy"|"sell"}` | 200 `{trade:{id,ticker,side,quantity,price,executed_at}, portfolio:{...GET /api/portfolio shape}}`; 400 on validation failure |
| `GET /api/portfolio/history` | – | `{snapshots:[{total_value, recorded_at}]}` oldest→newest |
| `GET /api/watchlist` | – | `{tickers:[{ticker, price, previous_price, change, change_percent, direction, timestamp}]}` (price fields `null` until first price) |
| `POST /api/watchlist` | `{ticker}` | 201 with a watchlist item; 200 with the item if already present (idempotent); 400 invalid |
| `DELETE /api/watchlist/{ticker}` | – | 200 `{"removed":"<TICKER>"}`; 404 if not on the watchlist |
| `POST /api/chat` | `{message}` | `{message, trades:[{ticker, side, quantity, status:"executed"|"failed", price?, error?}], watchlist_changes:[{ticker, action:"add"|"remove", status:"executed"|"failed", error?}], error?}` |
| `GET /api/chat/history` | – | `{messages:[{id, role, content, actions, created_at}]}` oldest→newest (last 50) |
| `GET /api/stream/prices` | – | SSE (see §1.8) |

`actions` stored on assistant messages is `{"trades":[...], "watchlist_changes":[...]}` (the same result objects as above).

## 5. Frontend test hooks (frontend-engineer must add these; integration-tester relies on them)

| `data-testid` | Element |
|---|---|
| `connection-status` | header dot; attribute `data-status="connected|reconnecting|disconnected"` |
| `header-total-value`, `header-cash` | header numbers (text like `$10,000.00`) |
| `watchlist` | watchlist container |
| `watchlist-row-{TICKER}` | each row; contains `price-{TICKER}` (price text) |
| `watchlist-add-input`, `watchlist-add-button`, `watchlist-remove-{TICKER}` | watchlist management |
| `main-chart`, `main-chart-ticker` | selected-ticker chart and its label |
| `trade-ticker`, `trade-quantity`, `trade-buy`, `trade-sell`, `trade-message` | trade bar (`trade-message` shows success/error text) |
| `positions-table`, `position-row-{TICKER}` | positions table |
| `heatmap`, `heatmap-cell-{TICKER}` | treemap (cell has `data-pnl="positive|negative|flat"`) |
| `pnl-chart` | P&L chart |
| `chat-panel`, `chat-input`, `chat-send`, `chat-loading`, `chat-message-user`, `chat-message-assistant`, `chat-action` | chat (`chat-action` = inline trade/watchlist confirmation) |

## 6. Milestones / handoffs

1. **M1 (parallel):** db layer + tests; services/API skeleton against the db interface; llm module with mock mode + tests; frontend UI against the contract (it can mock data until the backend is up); Dockerfile/scripts.
2. **M2:** `backend-engineer` reports "API complete" with `uvicorn` running locally and all backend tests green. `frontend-engineer` reports "static export builds". `devops-engineer` reports "image builds & serves UI + API".
3. **M3:** `integration-tester` runs Playwright E2E against the running app (local uvicorn serving `frontend/out`, and/or the Docker compose test setup). It files issues by SendMessage to the owning member, with the failing test, the observed vs. expected result, and repro steps, and re-runs until green.
4. **Done** when all unit tests pass, all E2E scenarios in PLAN.md §12 pass, and `scripts/start_windows.ps1` brings up a working app.
