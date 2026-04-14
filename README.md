# SnapTrade Admin Panel

React frontend + Node/Express backend, started together from the repo root.

## Purpose

Admin UI for managing SnapTrade users, launching the connection portal, and viewing connected brokerage accounts and holdings.

## High‑level Architecture

**Frontend (React)**
- Admin panel UI to register users, generate portal links, list connected broker accounts, and render holdings.
- Stores SnapTrade user secrets in browser `localStorage` for local/dev use.
- Calls backend APIs for SnapTrade operations (no direct SnapTrade calls from the browser).

**Backend (Node/Express)**
- Acts as a secure proxy to SnapTrade APIs.
- Exposes endpoints for:
  - user lifecycle (create, list, delete)
  - connection portal creation
  - accounts and holdings retrieval
- Adds verbose request/response logging for debugging.

**SnapTrade**
- External service handling brokerage auth and account data.
- Requires app credentials (clientId + consumerKey) and per-user credentials (userId + userSecret).

## Data Flow (High Level)

1. Admin registers a user → SnapTrade returns `userId` + `userSecret`.
2. Admin generates portal → user connects a brokerage.
3. Admin requests accounts/holdings → backend fetches from SnapTrade → UI renders.

## Environment

Create `backend/.env`:

```env
SNAPTRADE_CLIENT_ID=your_client_id
SNAPTRADE_CONSUMER_KEY=your_consumer_key
```

> Note: `userSecret` is stored in browser `localStorage` for dev/admin use only.

## Run (one command)

```bash
npm run start-dev
```

What this does:

- Finds free ports automatically (no `.env` port configuration)
- Starts the backend first, then the frontend
- Waits for the backend process itself to be ready before starting the frontend
- On Ctrl+C, stops both processes and releases the ports

SnapTrade-dependent API actions still require valid credentials in `backend/.env`.

## Open in your browser

The script prints the exact URLs it picked.

- Frontend: `http://localhost:<frontendPort>`
- Backend: `http://localhost:<backendPort>`

## Stop

Press **Ctrl+C** in the terminal where it’s running.