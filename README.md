# kaffe-skam

> *Kaffeskam* — the gentle pang of guilt that arrives with the third latte before lunch.

A live dashboard for **Os & Data**'s office coffee machines. Polls the Eversys
Telemetry API, derives per-brew CO₂eq from actual ingredient data, and serves a
landscape display intended to hang next to the machines.

```
┌──────────────────────────────┬───────────────────────────────────┐
│                              │  SENESTE BRYG · 3. SAL · 12.30    │
│  DAGENS KAFFE-CO₂EQ          │                                   │
│                              │  Cappuccino                       │
│   1.4 kg CO₂                 │  7,0 g kaffe · 120 ml mælk        │
│   ≈ 7 km i bil               │                                   │
│                              │  176 g CO₂                        │
│                              │  +168 g  vs. almindelig kaffe     │
│  KOPPER   DENNE MÅNED        │                                   │
│  38       1.4 kg             │  TIDLIGERE                        │
│                              │  2. SAL  12.18  Espresso    9 g   │
│                              │  3. SAL  12.05  Latte mac. 317 g  │
└──────────────────────────────┴───────────────────────────────────┘
```

Visual language borrowed from [thoravej29.dk](https://thoravej29.dk) — warm
paper-tone background, light-weight Swiss grotesque (General Sans), and a
single terracotta accent for the delta. Readable from across a room, designed
to translate cleanly to a future ESP32 + e-ink client (see
`docs/superpowers/specs/`).

## Quick start

```bash
git clone git@github.com:NielsOerbaek/kaffe-skam.git
cd kaffe-skam
npm install
cp .env.example .env       # fill in EVERSYS_TOKEN and EVERSYS_MACHINES
npm run dev                # open http://localhost:8080
```

## Configuration

Two files:

- **`.env`** (gitignored) — secrets.
  ```env
  EVERSYS_TOKEN=<your Eversys API bearer token>
  EVERSYS_MACHINES=28199:2. sal,19708:3. sal
  ```
  `EVERSYS_MACHINES` is a comma-separated list of `machineId:floorLabel`
  pairs. The floor label is shown verbatim in the UI.

- **`config.json`** (committed) — CO₂ factors, polling intervals, default
  bean grams per drink, server port. The defaults match Os & Data's organic
  whole milk and low-impact beans (`1.24 g CO₂eq/g`). Adjust when you change
  your supplier.

`process.env` overrides `.env`, so you can inject secrets via systemd/docker
without writing a file.

## How CO₂ is computed

```
co2_g(brew) = beans_g × 1.24   +   milk_ml × 1.4
```

Electricity and water are deliberately excluded — the bean and milk terms
dominate; the model stays simple.

**Caveat on `beans_g`:** the Eversys API doesn't expose grams of coffee per
brew. We use a default-grams table per drink type (e.g. `ESPRESSO: 7g`,
doubled when `isDouble`), then periodically scale by a calibration factor `k`
so the total matches the machine's bean counter. Per-brew grams are
approximate; daily/monthly totals are accurate to the kg over time. See the
"Estimating `beans_g` per brew" section of the spec.

## Architecture

One Node.js process running on a Raspberry-Pi-class always-on box.

```
┌─────────────────────────────────────────────────────┐
│  kaffe-skam (one process, systemd-managed)          │
│                                                     │
│  ┌──────────┐   ┌──────────┐   ┌─────────────────┐  │
│  │ Poller   │──▶│  Store   │◀──│ HTTP server     │  │
│  │ (5s/60s) │   │ (SQLite) │   │  /api/state JSON│  │
│  └──────────┘   └──────────┘   │  /  static UI   │  │
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
| `store.ts` | SQLite schema + query surface |
| `poller.ts` | brew + counter polling loops, per-machine state, calibration |
| `merge.ts` | splash-of-milk → previous-brew merge state machine (pure) |
| `co2.ts` | pure CO₂ math + drink-type humaniser |
| `beans.ts` | per-drink default grams + calibration math |
| `server.ts` | `/api/state` and static file handler |

Frontend in `public/`: vanilla HTML/CSS/JS, no build step.

## Multi-machine

`EVERSYS_MACHINES` accepts any number of machines. Each one gets its own
polling state, splash-merge pending row, and bean calibration factor.
Totals on the left of the dashboard are summed across all machines. The
right pane shows the three most recent brews regardless of which floor
produced them, each labelled with its floor.

## The splash rule

Eversys reports milk-only top-ups (`MILK`, `MILK_FOAM`,
`HOT_WATER_WITH_MILK`) as separate brews. The poller merges any such
follow-up into its preceding brew on the **same machine**, provided it
arrives within 5 minutes. Each merge extends the window from its own
timestamp, so two splashes one after the other still attach to the
original brew.

## Endpoints

- `GET /` — dashboard HTML.
- `GET /api/state` — JSON payload that the dashboard (and the future
  ESP32 client) polls. Stable contract:

  ```json
  {
    "today":   { "cups": 38,  "co2_g": 1422.0 },
    "month":   { "cups": 504, "co2_g": 42100.0 },
    "lastBrews": [
      {
        "type": "CAPPUCCINO",
        "displayName": "Cappuccino",
        "floor": "2. sal",
        "machineTs": "2026-05-20T12:30:00",
        "beansG": 7.0,
        "milkMl": 120.0,
        "co2G": 176.68,
        "splashCount": 1,
        "deltaVsCoffee": 168.0
      }
    ],
    "stale": false,
    "lastPollOkAt": "2026-05-20T10:30:00.000Z"
  }
  ```

  `lastBrews` is newest-first, up to 3 entries. `stale: true` when the
  poller hasn't successfully reached Eversys in 60 s.

## Running in production

```bash
sudo cp systemd/kaffe-skam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kaffe-skam
sudo journalctl -fu kaffe-skam
```

The unit assumes the project lives at `/opt/kaffe-skam` and runs as a
`kaffe` user. Adjust the paths and user in
`systemd/kaffe-skam.service` if needed.

## Tests

```bash
npm test          # 68 tests across 8 files
npm run typecheck # strict TS, noUncheckedIndexedAccess
```

Tests cover the pure modules (CO₂, beans calibration, splash-merge),
the SQLite store (with in-memory DB), the API client (with a stubbed
fetch and recorded fixtures), the poller (across multiple machines),
and the HTTP server. No real network is used.

## Docs

- `docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md` —
  design spec (CO₂ model, schema, merge rule, calibration strategy).
- `docs/superpowers/plans/2026-05-20-kaffe-co2-dashboard.md` —
  implementation plan (13 bite-sized TDD tasks).

## Roadmap

- Per-brew bean mass derived from `grindTime` × grinder rate.
- ESP32 + 4.7" e-ink client (LilyGO T5 V2) — same `/api/state` contract,
  redraws every 30 s.
- Weekly digest email summarising office CO₂ trends.
