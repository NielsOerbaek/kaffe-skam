# Kaffe-skam: Coffee Machine CO2 Dashboard — Design

**Status:** approved
**Date:** 2026-05-20
**Owner:** Niels (niels@ogtal.dk)

## Purpose

Show, in real time, the estimated CO2-equivalent emissions caused by Os & Data's
office coffee machine. The web prototype runs on a small always-on box (Raspberry
Pi class) and serves a dashboard intended to be hung next to the machine. It is
a stepping stone: the same backend will later drive an ESP32 + e-ink display.

The dashboard exists to make a normally invisible cost visible — especially the
disproportionate impact of milk-based drinks compared with plain coffee.

## Scope

In:
- Polling the Eversys Telemetry API (v3) for one machine.
- Computing per-brew CO2 from actual machine-reported ingredient quantities.
- Persisting brews to SQLite.
- A single-page landscape dashboard served from the same process.
- "Splash of milk" follow-ups merged into the previous brew.

Out (deferred):
- The ESP32 + e-ink display client itself (only the JSON contract is locked).
- Multiple machines.
- Historical backfill on first run (we start tallying from install moment).
- Authentication on the dashboard (assumed LAN-only).
- Authoring/editing brew records from the UI.

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| CO2 model | Ingredient-based, derived from real per-brew API data |
| Layout | Landscape split: today's headline left, last brew + delta-vs-Coffee right |
| Hosting | Single Node.js + TypeScript process on a Pi-class always-on box |
| Polling rate | 5 s for brew history; 60 s for sanity-check counters |
| Persistence | SQLite from day one |
| Splash-merge rule | Only `MILK`, `MILK_FOAM`, `HOT_WATER_WITH_MILK` brews within 5 min after the previous brew |
| Styling | Generic dark / e-ink-friendly look (no brand styling required) |
| Frontend build | None — vanilla JS, one HTML, one CSS |
| ESP32 | Out of scope, but the `/api/state` JSON is the contract |

## CO2 model

```
co2_g(brew) = beans_g * BEANS_FACTOR  +  milk_ml * MILK_FACTOR

BEANS_FACTOR     = 1.24  g CO2eq per g  (Os & Data's specific coffee)
MILK_FACTOR      = 1.4   g CO2eq per ml (organic whole cow's milk, default LCA value)
COFFEE_BASELINE  = 7 * 1.24 = 8.68 g CO2eq   (plain Coffee, used for the delta panel)
```

Electricity and water are explicitly excluded from the calculation (decision:
keep the model simple, dominant terms only).

All three constants live in `config.json` (committed) so they can be swapped
without code changes.

### Estimating `beans_g` per brew (data gap)

The Eversys API does **not** expose grams of coffee per brew directly.
`ProductHistoryModelNew` exposes `grindTime`, `extractionTime`, and
`cakeThickness` (puck thickness target), but no mass. The only authoritative
bean-mass figure is the cumulative `MachineCounterModel.beans.totalQuantity`
in kg, plus an `isDouble` flag per brew.

**Strategy** — drink-type default table, periodically calibrated against the
machine total:

1. Maintain a default-grams table per drink type:
   ```
   RISTRETTO: 8       ESPRESSO: 7        COFFEE: 7
   AMERICANO: 7       MILK_COFFEE: 7     CAPPUCCINO: 7
   ESPRESSO_MACCHIATO: 7   LATTE_MACCHIATO: 7   WHITE_AMERICANO: 7
   FILTER_COFFEE: 10  COFFEE_POT: 14     FILTER_COFFEE_POT: 20
   default (unknown): 7
   ```
   Double = `2 *` the type value if `isDouble == 1`.

2. On every counter sanity-check tick (60 s):
   - Compute `summed_g_since_last_calibration` from our `brews.beans_g`.
   - Compute `actual_g_delta = (counter_kg_now - counter_kg_at_last_calibration) * 1000`.
   - If we have ≥ 50 brews since last calibration: derive a multiplicative
     scale `k = actual_g_delta / summed_g_since_last_calibration`, persist
     `k` in `meta` table.
   - All future per-brew `beans_g` values get multiplied by `k` at insert.

This keeps per-brew numbers plausible from day one and exact-to-the-kg over
time. The table lives in `config.json` so it can be hand-tuned.

The defaults table is a starting guess; we may revise after observing real
brew data.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  kaffe-skam (one Node process, systemd-managed)      │
│                                                      │
│  ┌──────────┐   ┌──────────┐   ┌─────────────────┐   │
│  │ Poller   │──▶│  Store   │◀──│ HTTP server     │   │
│  │ (5s/60s) │   │ (SQLite) │   │  /api/state JSON│   │
│  └──────────┘   └──────────┘   │  /  static UI   │   │
│       │                        └─────────────────┘   │
│       ▼                                ▲             │
│   Eversys API                          │             │
│                                        ▼             │
│                              Browser  /  later ESP32 │
└──────────────────────────────────────────────────────┘
```

One process, three internal modules sharing SQLite. The HTTP boundary at
`/api/state` is the natural future split point and the contract the ESP32 client
will consume unchanged.

## Modules

Each module has one clear purpose and a small public surface.

### `poller`
Fetches new brews and counter snapshots on a timer.

- Inputs: machine id + token (from `.machine_id` / `.token`), poll rate, store handle.
- Output: writes to store; no return values to other modules.
- Behavior:
  - Every 5 s: `GET /v3/machines/{id}/products?afterId={last_seen_id}&sortOrder=ASC&limit=100`.
  - Every 60 s: `GET /v3/machines/machine-counters/{id}` for sanity-check totals.
  - Backs off on 429 / 5xx (5 s → 10 s → 30 s → 60 s; resets on 200).
  - Reloads token + machine id on SIGHUP.

### `merge`
Pure state machine that decides whether a new brew is a "splash" continuation
of the previous one, or a new primary brew.

- Inputs: incoming `ProductHistoryModelNew`, current pending brew (if any).
- Outputs: instructions — `{ commit?: PendingBrew, newPending?: PendingBrew, mergedSplash?: …}`.
- No I/O. Fully unit-testable.

Rule:
- Splash = type ∈ {`MILK`, `MILK_FOAM`, `HOT_WATER_WITH_MILK`}.
- Merge if previous brew exists AND incoming is a splash AND incoming.machineTs ≤ previous.machineTs + 5 min.
- On merge: accumulate `milk_ml`, append id to `splash_ids`, reset the 5-min window from the merging brew's timestamp.
- Flush a pending brew to permanent storage when (a) a non-splash arrives, or (b) the 5-min window has passed on a poll tick.

### `store`
SQLite. Owns the schema and all queries.

```sql
CREATE TABLE brews (
  id              INTEGER PRIMARY KEY,        -- Eversys product-history id of the primary brew
  machine_ts      TEXT NOT NULL,              -- ISO 8601 from machine
  local_date      TEXT NOT NULL,              -- YYYY-MM-DD (Pi local time)
  local_month     TEXT NOT NULL,              -- YYYY-MM
  drink_type      TEXT NOT NULL,              -- ESPRESSO, CAPPUCCINO, ...
  is_double       INTEGER NOT NULL,           -- 0/1 from ProductHistoryModelNew.isDouble
  beans_g         REAL NOT NULL,              -- estimated; see "Estimating beans_g per brew"
  milk_ml         REAL NOT NULL,              -- includes merged splashes
  co2_g           REAL NOT NULL,              -- computed at insert, never recomputed
  splash_ids      TEXT,                       -- JSON array of merged ids, NULL if none
  raw_json        TEXT NOT NULL               -- original payload for debug/replay
);
CREATE INDEX idx_brews_local_date  ON brews(local_date);
CREATE INDEX idx_brews_local_month ON brews(local_month);

CREATE TABLE pending_brew (
  id INTEGER PRIMARY KEY,    -- only ever 0 or 1 row, key is always 1
  brew_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
-- meta keys:
--   last_seen_id
--   last_poll_ok_at
--   last_counter_check_at
--   schema_version
--   beans_calibration_k                 (float; multiplier applied to default beans_g)
--   beans_calibration_anchor_kg         (cumulative counter at last calibration)
--   beans_calibration_anchor_summed_g   (our summed beans_g at last calibration)
```

Query surface:
- `insertBrew(brew)` — single committed brew.
- `setPending(brew) / clearPending() / getPending()`.
- `getTodayTotals(localDate)` → `{cups, co2_g}`. A "cup" is one committed `brews` row; if a pending brew exists with matching `local_date`, it counts too. Merged splashes do **not** add to the cup count.
- `getMonthTotals(localMonth)` → `{cups, co2_g}`. Same rule as above.
- `getLastBrew()` → most recent committed OR pending brew.
- `getMeta(key) / setMeta(key, value)`.

### `co2`
Pure functions. Reads from `config.json`.

- `co2ForBrew(beansG, milkMl): number`
- `humanizeType(typeEnum): string`  (`LATTE_MACCHIATO` → `"Latte Macchiato"`)
- `deltaVsCoffee(co2G): number`

### `server`
HTTP. Exposes:

- `GET /api/state` — single JSON blob (see below).
- `GET /` and `/static/*` — the dashboard files.

### `index`
Wires modules together, owns the lifecycle (start, SIGHUP, SIGTERM).

## API contract — `/api/state`

The shape the ESP32 client will also consume. Keep it tight:

```json
{
  "today":   { "cups": 38,  "co2_g": 1422.0 },
  "month":   { "cups": 504, "co2_g": 42100.0 },
  "lastBrew": {
    "type": "CAPPUCCINO",
    "displayName": "Cappuccino",
    "machineTs": "2026-05-20T13:41:02",
    "beansG": 7.2,
    "milkMl": 120.0,
    "co2G": 176.93,
    "splashCount": 1,
    "deltaVsCoffee": 168.25
  },
  "stale": false,
  "lastPollOkAt": "2026-05-20T13:42:01Z"
}
```

- `lastBrew` is `null` if no brews have ever been observed.
- `stale: true` if `lastPollOkAt` is more than 60 s old.

## Data flow

### Bootstrap (first run, empty DB)
1. `GET /products?sortOrder=DESC&limit=1` → get most recent brew id.
2. Persist as `last_seen_id`. No backfill.
3. Counters start at zero from install moment (documented behavior).

### Steady state (every 5 s)
1. `GET /products?afterId={last_seen_id}&sortOrder=ASC&limit=100`.
2. For each new brew in order:
   - Run through the `merge` state machine.
   - Apply any resulting `commit` (insert brew row) and/or `newPending` (update pending_brew).
   - Advance `last_seen_id`.
3. Even with no new brews: check whether `pending_brew.expires_at` has passed; if so, flush it.

### Calibration + sanity-check loop (every 60 s)
1. `GET /machine-counters/{id}`.
2. If we have ≥ 50 new brews since `beans_calibration_anchor_*`, run the
   beans-calibration step (see "Estimating beans_g per brew") and update the
   `k` multiplier in `meta`. Existing rows are not rewritten — only future
   inserts use the new `k`.
3. Log warnings on large drift but don't block the dashboard. Counter resets
   on the machine (`lastReset` change) clear the calibration anchor.

### Frontend
- `setInterval(fetchState, 3000)`.
- Replace the DOM contents on each successful response. No diffing.
- On fetch error: keep last render, dim the timestamp.

## Frontend layout

Landscape split, single screen, no scrolling:

```
┌─────────────────┬──────────────────────────────┐
│  Today's        │  Last brew · 13:41           │
│  coffee CO₂eq   │  Cappuccino                  │
│                 │  7 g beans · 120 ml milk · +splash
│   1.4 kg        │                              │
│   ≈ 7 km drive  │  +168 g                      │
│                 │  vs plain Coffee (9 g)       │
│  Cups   Month   │                              │
│  38     42 kg   │  [bar comparison]            │
└─────────────────┴──────────────────────────────┘
```

Dark background, single accent color, large type. Designed to be legible from
across a room and to translate cleanly to monochrome e-ink later.

## Error handling

| Failure | Handling |
|---|---|
| API 429 | Exponential backoff in poller. Surface as `stale` after 60 s. |
| API 5xx / network | Same backoff. Logged. |
| SQLite write error | Process exits. systemd restarts. Don't limp along with bad state. |
| Malformed `config.json` at startup | Fail loud, log, exit. |
| Token / machine-id file missing | Fail loud, log, exit. |
| Counter reset on the machine (`lastReset` changes) | Logged. Doesn't affect us — we work off brew history, not counters. |
| Frontend fetch error | Keep last render, dim the timestamp. No alerts. |

## Testing

- **`co2.test.ts`** — table-driven tests of `co2ForBrew`, `humanizeType`, `deltaVsCoffee`.
- **`merge.test.ts`** — table-driven tests of the splash-merge state machine. Inputs are sequences of `ProductHistoryModelNew` fixtures; outputs are sequences of `{commit, newPending}` decisions. Covers: lone espresso, espresso + milk splash, milk-only (no preceding brew), splash arriving 5min 1s after (no merge), two splashes in quick succession.
- **`calibration.test.ts`** — table-driven tests for the bean-mass calibration. Covers: first-run (no anchor yet), normal calibration after 50 brews, counter reset (anchor cleared), clamped extreme scale.
- **`integration.test.ts`** — wires poller + store + server with a mocked HTTP client returning canned Eversys responses. Asserts `/api/state` output. In-memory SQLite.
- **fixtures/** — recorded responses from the real machine (token stripped), committed.
- No frontend tests in the prototype.

## Repo layout

```
kaffe-skam/
  src/
    poller.ts
    store.ts
    co2.ts
    merge.ts
    server.ts
    config.ts
    index.ts
  public/
    index.html
    app.js
    style.css
  test/
    co2.test.ts
    merge.test.ts
    calibration.test.ts
    integration.test.ts
    fixtures/
  docs/superpowers/specs/
    2026-05-20-kaffe-co2-dashboard-design.md   (this file)
  config.json
  package.json
  tsconfig.json
  README.md
  .machine_id    (gitignored, existing)
  .token         (gitignored, existing)
  .gitignore
```

## Configuration

`config.json` (committed):

```json
{
  "co2": {
    "beansFactorGPerG": 1.24,
    "milkFactorGPerMl": 1.4,
    "coffeeBaselineG": 8.68
  },
  "beansDefaultsG": {
    "RISTRETTO": 8, "ESPRESSO": 7, "COFFEE": 7,
    "AMERICANO": 7, "MILK_COFFEE": 7, "CAPPUCCINO": 7,
    "ESPRESSO_MACCHIATO": 7, "LATTE_MACCHIATO": 7,
    "WHITE_AMERICANO": 7, "FILTER_COFFEE": 10,
    "COFFEE_POT": 14, "FILTER_COFFEE_POT": 20,
    "_default": 7
  },
  "calibration": {
    "minBrewsBetweenCalibrations": 50,
    "maxScaleDelta": 0.5
  },
  "polling": {
    "brewsIntervalMs": 5000,
    "countersIntervalMs": 60000,
    "splashWindowMs": 300000,
    "backoffMs": [5000, 10000, 30000, 60000]
  },
  "server": {
    "port": 8080,
    "stateRefreshMs": 3000
  }
}
```

`calibration.maxScaleDelta` clamps the per-calibration change in `k` (so a
single mis-read counter can't flip CO2 numbers by 5×).

`.token` and `.machine_id` are read at startup, never logged, never sent to
the frontend.

## ESP32 path (informational)

When we get to the device:
- ESP32 makes the same `GET /api/state` call against the Pi.
- It renders the same landscape layout to e-ink (probably refreshed every minute, partial refreshes for the "last brew" panel).
- No state on the device. The Pi remains the only thing talking to Eversys.
- If the Pi is unreachable, the device shows the last-known state and a small offline indicator.

## Open questions (none blocking)

- Real electricity factor — measure with a smart plug once installed, then optionally reintroduce as a flat per-brew term in config.
- Whether the office wants a weekly e-mail summary later (not in scope).
- The per-drink default-grams table is a starting guess; we may revise after observing real brews and the calibration scale `k`.
