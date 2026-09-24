# FinAlly — AI Trading Workstation

A visually stunning AI-powered trading workstation that streams live market data, simulates portfolio trading, and integrates an LLM chat assistant that can analyze positions and execute trades via natural language.

Built entirely by coding agents as a capstone project for an agentic AI coding course.

## Features

- **Live price streaming** via SSE with green/red flash animations
- **Simulated portfolio** — $10k virtual cash, market orders, instant fills
- **Portfolio visualizations** — heatmap (treemap), P&L chart, positions table
- **AI chat assistant** — analyzes holdings, suggests and auto-executes trades
- **Watchlist management** — track tickers manually or via AI
- **Dark terminal aesthetic** — Bloomberg-inspired, data-dense layout

## Architecture

Single Docker container serving everything on port 8000:

- **Frontend**: Next.js (static export) with TypeScript and Tailwind CSS
- **Backend**: FastAPI (Python/uv) with SSE streaming
- **Database**: SQLite with lazy initialization
- **AI**: LiteLLM → OpenRouter (Cerebras inference) with structured outputs
- **Market data**: Built-in GBM simulator (default) or Massive API (optional)

## Quick Start

Requires Docker (Docker Desktop on macOS/Windows).

```bash
# 1. Configure
cp .env.example .env
# edit .env and set OPENROUTER_API_KEY (optional: MASSIVE_API_KEY)

# 2. Start (builds the image on first run, then opens http://localhost:8000)
./scripts/start_mac.sh            # macOS / Linux
.\scripts\start_windows.ps1       # Windows PowerShell

# 3. Stop (your data is kept in the `finally-data` volume)
./scripts/stop_mac.sh
.\scripts\stop_windows.ps1
```

Start script options: `--build` / `-Build` forces an image rebuild, and `--no-open` / `-NoOpen` skips opening the browser. Both scripts are idempotent, so you can re-run them safely. If `.env` is missing, it is created from `.env.example`. The app still runs, but AI chat needs a real key (or `LLM_MOCK=true`).

If PowerShell blocks the script, run `powershell -ExecutionPolicy Bypass -File .\scripts\start_windows.ps1`.

### Plain Docker

```bash
docker build -t finally .
docker run -d --name finally -v finally-data:/app/db -p 8000:8000 --env-file .env finally
```

Or use `docker compose up --build`. Compose is an optional convenience for local development.

To reset all data, run `docker volume rm finally-data` while the container is stopped.

### Local development (without Docker)

```bash
# Backend (http://localhost:8000)
cd backend
uv sync --extra dev
uv run uvicorn app.main:app --reload --port 8000

# Frontend dev server (http://localhost:3000, proxies /api to :8000)
cd frontend
npm install
npm run dev
```

Backend tests: `cd backend && uv run --extra dev pytest`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for AI chat |
| `MASSIVE_API_KEY` | No | Massive (Polygon.io) key for real market data; omit to use simulator |
| `LLM_MOCK` | No | Set `true` for deterministic mock LLM responses (testing) |

## Project Structure

```
finally/
├── frontend/    # Next.js static export
├── backend/     # FastAPI uv project
├── planning/    # Project documentation and agent contracts
├── test/        # Playwright E2E tests
├── db/          # SQLite volume mount (runtime)
└── scripts/     # Start/stop helpers
```

## License

See [LICENSE](LICENSE).
