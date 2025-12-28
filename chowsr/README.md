# chowsr

Vite + React frontend with an Express API and a SQLite database (via `better-sqlite3`).

## Requirements

- Node.js 20+

## Quickstart

```bash
npm install
cp .env.example .env
```

Run the API and UI in two terminals:

```bash
# terminal 1 (API)
npm run dev:server

# terminal 2 (UI)
npm run dev
```

- UI: `http://localhost:5173`
- API: `http://localhost:8787` (proxied under `/api` by Vite during `npm run dev`)

Health check:

```bash
curl http://localhost:8787/api/health
```

## Scripts

- `npm run dev` - start Vite dev server
- `npm run dev:server` - start the Express API
- `npm run build` - build the frontend to `dist/`
- `npm run start` - start the API (serves `dist/` if present)
- `npm test` - run server unit tests
- `npm run test:coverage` - run tests with 100% coverage thresholds (server code)

## Configuration

Environment variables are read from `.env` (see `.env.example`).

Common ones:

- `PORT` - API port (default `8787`)
- `DB_PATH` - SQLite DB path (default `./data/chowsr.db`)
- `APP_BASE_URL` - used when generating invite links
- `OSM_USER_AGENT` / `OVERPASS_URLS` - used for OpenStreetMap / Overpass requests
- `ENABLE_EMAIL` / `RESEND_API_KEY` / `EMAIL_FROM` - email invites/results
- `ENABLE_SMS` / `TWILIO_*` - SMS invites/results

## Deployment

### Docker

```bash
docker build -t chowsr .
docker run --rm -p 8080:8080 -e PORT=8080 -e DB_PATH=/data/chowsr.db -v "$PWD/data:/data" chowsr
```

### Fly.io

This repo includes `fly.toml` with a persistent volume mount at `/data` and a default `DB_PATH` of `/data/chowsr.db`.

```bash
fly deploy
```

#### GitHub deploys

On merges to `main`, GitHub Actions can deploy to Fly if you add a repository secret named `FLY_API_TOKEN`.

## Notes

- Don't commit `.env` (it often contains secrets).

