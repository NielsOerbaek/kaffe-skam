# kaffe-skam

CO2 dashboard for the Os & Data office coffee machine. Polls the Eversys
Telemetry API, estimates per-brew CO2 from real ingredient data, and serves
a landscape dashboard at `:8080/`.

## Prerequisites

- Node.js ≥ 20
- An Eversys API token + machine id in `.token` and `.machine_id` (not committed)

## Install

```bash
npm install
```

## Configure

Edit `config.json` for CO2 factors, polling intervals, etc.
See `docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md` for details.

## Run (dev)

```bash
npm run dev
```

## Run (production on a Pi)

```bash
sudo cp systemd/kaffe-skam.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kaffe-skam
sudo journalctl -fu kaffe-skam
```

## Tests

```bash
npm test
```

## Endpoints

- `GET /` — dashboard
- `GET /api/state` — JSON state (also the contract for the future ESP32 client)

## Architecture

See [docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md](docs/superpowers/specs/2026-05-20-kaffe-co2-dashboard-design.md).
