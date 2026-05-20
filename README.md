# Kaffe og Carbon

> *Kaffeskam* — den lille stikken af dårlig samvittighed der følger med dagens
> tredje latte. **Kaffe og Carbon** is a live dashboard that names, counts,
> and weighs it. (The repository, the systemd unit, and the `/opt/`
> install path are still called `kaffe-skam` — that's just the codename.)

A wall display for the **Thoravej 29** office coffee machines. It polls the
Eversys Telemetry API, computes per-brew CO₂eq from the actual ingredients,
and serves a landscape interface intended to hang next to the machines. Live
at [kaffe.raakode.dk](https://kaffe.raakode.dk).

```
┌──────────────────────────────┬───────────────────────────────────┐
│  DAGENS CO₂EQ                │  SENESTE BRYG · 20. MAJ KL. 12.30 │
│                              │                                   │
│   2.1 kg CO₂                 │  Dbl. Latte   2. SAL              │
│   142 kopper i dag           │  10,5 g kaffe · 130 ml mælk       │
│                              │                                   │
│  ──────────────────────────  │  217 g CO₂                        │
│  MAJ 2026                    │  +1667 % vs. sort kaffe (13 g)    │
│  ──────────────────────────  │                                   │
│  ANTAL KOPPER  CO₂ UDLEDT    │  TIDLIGERE                        │
│  3.272         46,99 kg      │  3. SAL  Cortado          11 g    │
│                              │  2. SAL  Strong Coffee    15 g    │
│                              │  …                                │
└──────────────────────────────┴───────────────────────────────────┘
```

Visual language borrowed from [thoravej29.dk](https://thoravej29.dk) — warm
paper-tone background, light-weight Swiss grotesque (General Sans), a single
terracotta accent for delta numbers, a frosted-glass app bar across the top.
Designed to translate cleanly to a future ESP32 + e-ink client (see
`docs/superpowers/specs/`).

## Pages

| Path        | What you see |
|-------------|--------------|
| `/`         | The live dashboard described above. |
| `/timeline` | 30-day bar chart of CO₂ (or cups) per day, today highlighted, powered by Chart.js. |
| `/drinks`   | Drink-by-drink breakdown for the current month — grouped by the **machine button name** (Strong Coffee, Dbl. Latte, Cortado, etc.), ranked by CO₂, with a share bar and a per-cup delta against plain Coffee. |
| `/metode`   | Methodology page. The formula, the data sources, the honest caveats. |

## Quick start

```bash
git clone git@github.com:NielsOerbaek/kaffe-skam.git
cd kaffe-skam
npm install
cp .env.example .env       # fill in EVERSYS_TOKEN, EVERSYS_MACHINES, LOCATION_NAME
npm run dev                # open http://localhost:8080
```

## Configuration

Two files:

- **`.env`** (gitignored) — secrets and per-deployment knobs.
  ```env
  EVERSYS_TOKEN=<your Eversys API bearer token>
  EVERSYS_MACHINES=28199:2. sal,19708:3. sal
  LOCATION_NAME=Thoravej 29
  ```
  `EVERSYS_MACHINES` is a comma-separated list of `machineId:floorLabel`
  pairs (any number of machines). `LOCATION_NAME` is the brand label
  rendered in the top-left corner.

- **`config.json`** (committed) — CO₂ factors, polling intervals, default
  bean grams keyed by **machine button name** (with API drink-type as
  fallback), tea overrides, and any manual button-name overrides. The
  defaults match Thoravej 29's setup — adjust if you change suppliers or
  reprogram a machine.

`process.env` overrides `.env`, so you can inject secrets via systemd/docker
without writing a file.

## How CO₂ is computed

```
co2_g(brew) = beans_g × 1.24   +   milk_ml × 1.4
```

- **1.24 g CO₂eq / g beans** — from our coffee supplier
  [ØNSK kaffe](https://onsk.dk/impact-og-ansvarlighed/), unusually low
  compared to non-certified coffee (typically 15–17 g/g).
- **1.4 g CO₂eq / ml milk** — standard LCA value for Northern-European
  organic whole cow's milk.
- **Electricity, water, packaging, and logistics are deliberately excluded.**
  Beans and milk dominate; the rest would add noise without changing the
  ordering between an espresso and a latte. (See `/metode` for the long form.)

### How `beans_g` is estimated

The Eversys API does **not** tell us how many grams went into each brew.
We use a per-product-name lookup (`beansByProduct` in `config.json`):
`"Espresso" → 7g`, `"Dbl. Latte" → 14g`, `"Strong Coffee" → 8g`,
`"White tea 80°" → 0g`, etc. Then we apply a per-machine calibration
factor `k` so the sum of our estimates tracks the machine's bean counter.

Per-brew grams are therefore approximate; daily and monthly totals are
accurate to the kg over time. See the design spec for details.

### Drinks names

The Eversys API's `drink_type` field is the firmware's internal classification
and is unreliable as a label (a "Latte" gets classified as `CAPPUCCINO`,
"Espresso" as `MILK_COFFEE`, etc.). We instead show the **actual machine
button name** by joining each brew's `keyId` against the products fetched
from `/v3/machines/{id}/product-parameters`. The names refresh every hour.

For buttons the API doesn't name (e.g. `keyId = 61` is used for plain Hot
Water on these machines but isn't programmed), set a manual override:

```json
"productNameOverrides": { "61": "Hot Water" }
```

### Splash-of-milk rule

Eversys reports milk-only follow-ups (`MILK`, `MILK_FOAM`,
`HOT_WATER_WITH_MILK`) as separate brews. The poller merges any such
follow-up into its preceding brew on the **same machine**, provided it
arrives within 5 minutes. Each merge extends the window from its own
timestamp, so two splashes one after the other still attach to the
original brew.

## Architecture

One Node.js process running on a Raspberry-Pi-class always-on box, behind
your reverse proxy of choice.

```
┌─────────────────────────────────────────────────────┐
│  kaffe-skam (one process, systemd-managed)          │
│                                                     │
│  ┌──────────┐   ┌──────────┐   ┌─────────────────┐  │
│  │ Poller   │──▶│  Store   │◀──│ HTTP server     │  │
│  │ 5s / 60s │   │ (SQLite) │   │  /api/state     │  │
│  │ + 1h     │   │          │   │  /api/timeline  │  │
│  │ products │   │          │   │  /api/drinks    │  │
│  └──────────┘   └──────────┘   │  + static UI    │  │
│       │                        └─────────────────┘  │
│       ▼                                ▲            │
│   Eversys API                          │            │
│  (one client per machine)              │            │
│                                        ▼            │
│                              Browser  /  later ESP32│
└─────────────────────────────────────────────────────┘
```

Internal modules in `src/`:

| File | Responsibility |
|---|---|
| `index.ts` | wires everything, owns lifecycle and signal handling |
| `config.ts` | loads + validates `.env` and `config.json` |
| `api.ts` | typed Eversys HTTP client (one per machine), backoff classes |
| `store.ts` | SQLite schema + queries; runs forward-only migrations on startup |
| `poller.ts` | brew + counter polling loops, per-machine state, calibration, product-name refresh |
| `merge.ts` | splash-of-milk → previous-brew merge state machine (pure) |
| `co2.ts` | pure CO₂ math + drink-type humaniser |
| `beans.ts` | per-product / per-drink default grams + calibration math |
| `server.ts` | `/api/state`, `/api/timeline`, `/api/drinks`, and static file handler |

Frontend in `public/` (vanilla HTML/CSS/JS, no build step):

| File | Purpose |
|---|---|
| `index.html` + `app.js` | The live wall dashboard. |
| `timeline.html` + `timeline.js` | 30-day bar chart (Chart.js via CDN). |
| `drinks.html` + `drinks.js` | Per-button breakdown for the current month. |
| `metode.html` | Static methodology page. |
| `chrome.js` | Shared brand/clock/live-status updater for the sub-pages. |
| `style.css` | All styling — one stylesheet, no preprocessor. |

## Multi-machine

`EVERSYS_MACHINES` accepts any number of machines. Each one gets its own
poller state (`last_seen_id`, calibration anchor `k`, pending splash-merge
brew). Totals on the left of the dashboard are summed across all machines.
The right pane lists the six most recent brews regardless of floor, each
labelled with its origin.

## Endpoints

- `GET /` — dashboard HTML.
- `GET /timeline`, `GET /drinks`, `GET /metode` — sub-pages.
- `GET /api/state` — current dashboard state. Stable JSON contract; this is
  what the future ESP32 client will consume.

  ```json
  {
    "locationName": "Thoravej 29",
    "today":   { "cups": 142, "co2_g": 2188.0 },
    "month":   { "cups": 3272, "co2_g": 46990.0 },
    "lastBrews": [
      {
        "type": "CAPPUCCINO",
        "productName": "Dbl. Latte",
        "displayName": "Dbl. Latte",
        "floor": "2. sal",
        "machineTs": "2026-05-20T12:30:00",
        "beansG": 10.5,
        "milkMl": 130,
        "co2G": 217,
        "splashCount": 0,
        "deltaVsCoffee": 204.0
      }
    ],
    "stale": false,
    "lastPollOkAt": "2026-05-20T10:30:00.000Z"
  }
  ```

  `lastBrews` is newest-first (up to 6). `stale: true` when the poller
  hasn't successfully reached Eversys in 60 s. `productName: null` falls
  back to a Danish humanised `displayName`.

- `GET /api/timeline?days=N` — zero-filled daily series of cup + CO₂ totals
  for the last `N` days (1–365, default 30).
- `GET /api/drinks?month=YYYY-MM` — per-button-name breakdown for the
  given month (default: current). Includes a top-level `baselineG` and
  per-row `co2PerCupG` + `deltaVsCoffeePct`.

## Scripts

```bash
npm run dev                  # live-reload during development
npm test                     # 68 tests, vitest
npm run typecheck            # strict TS, noUncheckedIndexedAccess

npm run backfill             # fetch and store the last 30 days of brews
npm run backfill -- 365      # last full year (or 1–365)
npm run recompute            # reapply current config to every stored brew
                             #   (use after editing beansByProduct or
                             #    zeroMilkProducts)
```

The backfill paginates the `products` endpoint with `t1`/`t2` ASC pagination
and is fully idempotent (composite primary key `(machine_id, id)`). The
recompute walks every stored row and updates `beans_g`, `milk_ml`, and
`co2_g` from the current config + the most recent calibration `k`.

## Running in production

```bash
sudo cp systemd/kaffe-skam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kaffe-skam
sudo journalctl -fu kaffe-skam
```

The unit assumes the project lives at `/opt/kaffe-skam` and runs as a
dedicated `kaffe` system user. Adjust the paths and user in
`systemd/kaffe-skam.service` if needed.

Caddy block (TLS auto-issued via Let's Encrypt):

```caddyfile
kaffe.raakode.dk {
    reverse_proxy host.docker.internal:8080
}
```

## Tests

```bash
npm test          # 68 tests across 8 files
npm run typecheck # strict TS, noUncheckedIndexedAccess
```

Tests cover the pure modules (CO₂, beans calibration, splash-merge), the
SQLite store (with in-memory DB), the API client (with a stubbed fetch and
recorded fixtures), the poller (across multiple machines), and the HTTP
server. No real network is used.

## Docs

- [`docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md`](docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md)
  — design spec (CO₂ model, schema, merge rule, calibration strategy).
- [`docs/superpowers/plans/2026-05-20-kaffe-co2-dashboard.md`](docs/superpowers/plans/2026-05-20-kaffe-co2-dashboard.md)
  — implementation plan (13 bite-sized TDD tasks).

## Roadmap

- ESP32 + 4.7″ e-ink client (LilyGO T5 V2) — same `/api/state` contract,
  redraws every 30 s.
- Per-brew bean mass derived from `grindTime` × grinder rate (would replace
  the per-product-name defaults with measured values).
- Weekly digest email summarising office CO₂ trends.
- Annual view on `/timeline` (now that the DB holds a full year).
