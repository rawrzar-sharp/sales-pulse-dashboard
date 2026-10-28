# Sales Pulse Dashboard

A real-time, multi-user sales analytics dashboard built with zero npm dependencies. It runs on Node.js, serves a live REST and streaming API, and renders all charts and KPIs directly in the browser. Multiple users can add, edit, and delete records simultaneously — every change is pushed to all open browsers in under a second.

---

## Key Features

**Real-time collaboration**
Changes made by any user are broadcast instantly to every connected browser via Server-Sent Events. A watchdog polling mechanism covers environments where SSE is not supported (such as Cloudflare quick tunnels).

**Live KPI dashboard**
Five headline metrics — Total Sales, Order Count, Average Order Value, Completion Rate, and Average Rating — update with animated counters on every data change. Charts include a daily revenue trend, region bars, category donut, status breakdown, and top-5 product ranking.

**Click-to-filter**
Every chart segment is clickable. Selecting a region, category, or status filters the entire dashboard in real time. Date range presets (7D / 30D / 60D) anchor to the latest record, not today's date.

**Data integrity panel**
After every update, the dashboard re-sums each chart independently and compares the result to the KPI totals. Any mismatch is displayed in red. This guarantees that every chart always reflects the same underlying data.

**Inline record editor**
A modal form lets users create, edit, and delete records with full server-side validation. Optimistic concurrency control (via record versioning) prevents silent overwrites when two users edit the same row at the same time.

**Undo delete**
Deleting a record shows a toast notification with an Undo action. The original record can be fully restored within a few seconds.

**Live simulator**
A built-in simulator adds one random valid order every three seconds, useful for testing real-time behaviour and demonstrating the dashboard to stakeholders.

**Offline / local mode**
Opening `index.html` directly (without the server) switches to Local mode automatically. Data is stored in `localStorage` and synced between tabs of the same browser via `BroadcastChannel`.

**CSV export**
`data/export.csv` is rewritten within 150 ms of every change, making it available for Tableau Desktop or any other tool that reads flat files. A direct download endpoint is also provided at `/api/export.csv`.

**Power BI live push**
An optional integration streams every record change to a Power BI streaming dataset in real time. See `POWERBI_LIVE_SETUP.md` for setup instructions.

**Business Insights panel (in development)**
A planned Insights tab will analyse the live sales data and present prioritised, plain-language recommended actions for business stakeholders — flagging critical metrics, underperforming segments, refund spikes, and revenue momentum, with suggested next steps for each finding.

**No build step, no dependencies**
The entire server is a single Node.js file using only built-in modules. The browser side uses no frameworks or bundlers.

---

## Installation and Setup

**Requirements**

- Node.js 18 or later
- No npm install required

**Run locally**

```bash
node server.js
```

The dashboard is available at `http://localhost:3000`. The default port can be changed:

```bash
PORT=8080 node server.js
```

Windows PowerShell:

```powershell
$env:PORT = "8080"; node server.js
```

**Lock write access before sharing**

Without an edit key, anyone with the URL can modify data. Set a key to require authentication for all write operations (reads remain open):

```bash
EDIT_KEY=your-secret node server.js
```

Windows PowerShell:

```powershell
$env:EDIT_KEY = "your-secret"; node server.js
```

Users are prompted for the key once per browser session.

**Share over the internet**

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a public `https://` URL. Anyone with it sees the dashboard and all live updates. Named tunnels support SSE (instant push). Quick tunnels fall back to polling automatically.

**Offline / no server**

Open `public/index.html` directly in a browser. The dashboard runs in Local demo mode with data stored in `localStorage`.

---

## Running Tests

```bash
npm test
```

Runs 45+ unit and API tests using Node's built-in test runner. No additional packages needed.

For end-to-end browser tests (requires Python and Playwright):

```bash
pip install playwright
playwright install chromium
python test/e2e_playwright.py
```

The Playwright suite covers desktop, mobile, two-user live collaboration, offline mode, and edit key enforcement.

---

## Folder Structure

```
sales-pulse-dashboard/
├── server.js                   Zero-dependency HTTP server: REST API, SSE stream, CSV export
├── powerbi.js                  Power BI streaming dataset integration
├── powerbi-fields.json         Field schema definition for the Power BI push dataset
├── POWERBI_LIVE_SETUP.md       Step-by-step guide for enabling Power BI live push
├── package.json                Defines the test script (node --test); no dependencies
│
├── data/
│   ├── records.json            Live data file, written atomically after every change
│   ├── records.seed.json       Original 60 demo rows, used by the Reset function
│   └── export.csv              Auto-generated after every change, for Tableau and other tools
│
├── public/
│   ├── index.html              Single-page application shell and tab structure
│   ├── css/
│   │   └── styles.css          Theming (dark/light), animations, responsive/mobile layout
│   └── js/
│       ├── analytics.js        Single source of truth: all KPIs, filters, groupBy, CSV, validation
│       ├── app.js              UI wiring: tabs, editor dialog, charts, filters, toasts, boot
│       ├── charts.js           Dependency-free SVG/HTML chart kit: area, bar list, donut, tooltips
│       ├── config.js           Static configuration (Power BI embed URL override)
│       ├── seed.js             Seed data bundle for offline/local mode
│       └── store.js            Dual-backend store: Live (REST + SSE) or Local (localStorage)
│
└── test/
    ├── analytics.test.js       Unit tests for all analytics functions
    ├── insights.test.js        End-to-end data-flow tests: validation, KPIs, thresholds, insights
    ├── api.test.js             HTTP API tests: CRUD, concurrency, auth, SSE, persistence
    ├── powerbi.test.js         Power BI push integration tests
    ├── e2e_playwright.py       Full browser tests (desktop, mobile, multi-user, offline)
    └── screenshots/            Reference screenshots captured during E2E test runs
```

---

## API Reference

All endpoints are served by `server.js`. Write operations require the `x-edit-key` header when `EDIT_KEY` is set.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/records` | Returns all records and the current revision number |
| POST | `/api/records` | Creates a new record; returns the saved record with its assigned ID |
| PUT | `/api/records/:id` | Updates a record; include `baseVersion` to detect concurrent edits |
| DELETE | `/api/records/:id` | Deletes a record by ID |
| POST | `/api/reset` | Restores the original 60 seed rows for all users |
| GET | `/api/export.csv` | Downloads all records as a Tableau-compatible CSV file |
| GET | `/api/stream` | Server-Sent Events stream: `upsert`, `delete`, `reset`, `presence` events |
| GET | `/api/config` | Returns server configuration and live connection stats |
| GET | `/api/health` | Lightweight health check with current revision and row count |

---

## Technologies Used

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 18+ (built-in `http`, `fs`, `path` modules only) |
| Frontend | Vanilla JavaScript (ES2020), no frameworks or bundlers |
| Charts | Custom SVG and HTML chart library (`charts.js`) |
| Styling | CSS custom properties, CSS Grid and Flexbox, dark/light themes |
| Real-time | Server-Sent Events (SSE) with polling fallback |
| Persistence | JSON file with atomic write (write to `.tmp`, then rename) |
| Export | CSV generation compatible with Tableau Desktop and Power BI |
| Testing | Node.js built-in `node:test` runner, Playwright for E2E |
| Sharing | Cloudflare Tunnel (`cloudflared`) |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port the server listens on |
| `EDIT_KEY` | *(none)* | Secret key required for all write operations. If unset, writes are open to anyone. |
| `DATA_FILE` | `data/records.json` | Path to the live data file |
| `POWERBI_PUSH_URL` | *(none)* | Power BI streaming dataset push URL. Enables live push when set. |
| `POWERBI_FLUSH_MS` | `500` | How often buffered Power BI rows are flushed |
| `POWERBI_BACKFILL` | `0` | Set to `1` to push all existing records to Power BI on server start |

---

## Known Limitations

- **Storage**: Data is kept in a single JSON file. This is suitable for hundreds to low thousands of records and a small number of concurrent editors. For larger datasets, replace the storage layer in `server.js` with a database such as SQLite or PostgreSQL.
- **Concurrency model**: Last-write-wins within a session. Concurrent edits to the same record trigger a 409 conflict response, and the user is shown the current server state to review before saving again.
- **Power BI**: The embedded Power BI report iframe has its own data model and does not read live data from this server. Only the streaming push dataset integration is real-time.
- **Tableau Public embeds**: Require an internet connection and may be blocked by browser extensions.
