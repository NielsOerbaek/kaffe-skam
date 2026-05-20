import { createServer as nodeCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";
import type { ApiState } from "./types.ts";
import { humanizeType } from "./co2.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
};

export interface ServerOpts {
  store: Store;
  config: Config;
  publicDir: string;
}

export function createServer(opts: ServerOpts): Server {
  return nodeCreateServer((req, res) => handleRequest(req, res, opts));
}

function handleRequest(req: IncomingMessage, res: ServerResponse, opts: ServerOpts) {
  const rawUrl = req.url ?? "/";
  const qIdx = rawUrl.indexOf("?");
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const query = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");

  if (path === "/api/state")    return sendState(res, opts);
  if (path === "/api/timeline") return sendTimeline(res, opts, query);
  if (path === "/api/drinks")   return sendDrinks(res, opts, query);

  if (path === "/")          return serveStatic(res, opts.publicDir, "index.html");
  if (path === "/timeline")  return serveStatic(res, opts.publicDir, "timeline.html");
  if (path === "/drinks")    return serveStatic(res, opts.publicDir, "drinks.html");
  if (path === "/metode")    return serveStatic(res, opts.publicDir, "metode.html");

  if (path.startsWith("/static/")) {
    const rel = path.slice("/static/".length);
    return serveStatic(res, opts.publicDir, rel);
  }
  res.statusCode = 404; res.end("not found");
}

function sendTimeline(res: ServerResponse, opts: ServerOpts, q: URLSearchParams) {
  const daysRaw = Number(q.get("days") ?? "30");
  const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? Math.floor(daysRaw) : 30;
  const since = new Date(Date.now() - (days - 1) * 86400_000);
  const sinceDate = since.toISOString().slice(0, 10);
  const series = opts.store.getDailyTotals(sinceDate);
  // Fill in zero entries for days that had no brews, so the chart has a
  // contiguous timeline.
  const have = new Map(series.map(s => [s.date, s]));
  const filled: Array<{ date: string; cups: number; co2_g: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400_000);
    const key = d.toISOString().slice(0, 10);
    filled.push(have.get(key) ?? { date: key, cups: 0, co2_g: 0 });
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ days, series: filled }));
}

function sendDrinks(res: ServerResponse, opts: ServerOpts, q: URLSearchParams) {
  const monthQ = q.get("month");
  const month = monthQ && /^\d{4}-\d{2}$/.test(monthQ)
    ? monthQ
    : new Date().toISOString().slice(0, 7);
  const rows = opts.store.getByDrinkType(month);
  const total = rows.reduce((s, r) => s + r.co2_g, 0);
  const totalCups = rows.reduce((s, r) => s + r.cups, 0);

  // Same baseline as the Live page — current calibrated COFFEE estimate.
  const ks = opts.config.machines.map(m => {
    const raw = opts.store.getMeta(`beans_calibration_k_${m.id}`);
    return raw == null ? 1.0 : Number(raw);
  });
  const avgK = ks.length ? ks.reduce((s, k) => s + k, 0) / ks.length : 1.0;
  const baselineG = (opts.config.beansDefaultsG["COFFEE"] ?? 7) * avgK * opts.config.co2.beansFactorGPerG;

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    month,
    total: { cups: totalCups, co2_g: total },
    baselineG,
    drinks: rows.map(r => {
      const perCup = r.cups > 0 ? r.co2_g / r.cups : 0;
      // `displayName` from the store is either a resolved product name or
      // the raw drink_type. We separate them here so the frontend can apply
      // its own Danish fallback when no product name was found.
      const hasProduct = r.displayName !== r.drinkType;
      return {
        type: r.drinkType,
        productName: hasProduct ? r.displayName : null,
        displayName: hasProduct ? r.displayName : humanizeType(r.drinkType),
        cups: r.cups,
        co2_g: r.co2_g,
        co2PerCupG: perCup,
        deltaVsCoffeePct: baselineG > 0 ? (perCup / baselineG - 1) : 0,
        shareOfCo2: total > 0 ? r.co2_g / total : 0,
      };
    }),
  }));
}

function sendState(res: ServerResponse, opts: ServerOpts) {
  const now = new Date();
  const localDate = now.toISOString().slice(0, 10);
  const localMonth = now.toISOString().slice(0, 7);

  const today = opts.store.getTodayTotals(localDate);
  const month = opts.store.getMonthTotals(localMonth);
  const recent = opts.store.getRecentBrews(6);

  const floorByMachine = new Map(opts.config.machines.map(m => [m.id, m.floor]));

  // Live "sort kaffe" baseline: average each machine's calibration k, then
  // compute a plain COFFEE's CO₂ at the current calibrated dose.
  const ks = opts.config.machines.map(m => {
    const raw = opts.store.getMeta(`beans_calibration_k_${m.id}`);
    return raw == null ? 1.0 : Number(raw);
  });
  const avgK = ks.length ? ks.reduce((s, k) => s + k, 0) / ks.length : 1.0;
  const coffeeBeansG = (opts.config.beansDefaultsG["COFFEE"] ?? 7) * avgK;
  const baselineG = coffeeBeansG * opts.config.co2.beansFactorGPerG;

  const lastPollOkAt = opts.store.getMeta("last_poll_ok_at");
  const stale = lastPollOkAt
    ? (Date.now() - new Date(lastPollOkAt).getTime()) > 60_000
    : false;

  const state: ApiState = {
    today: { cups: today.cups, co2_g: today.co2_g },
    month: { cups: month.cups, co2_g: month.co2_g },
    lastBrews: recent.map(b => {
      const productName = opts.store.getProductName(b.machineId, b.productKey);
      return {
        type: b.drinkType,
        productName,
        displayName: productName ?? humanizeType(b.drinkType),
        floor: floorByMachine.get(b.machineId) ?? "?",
        machineTs: b.machineTs,
        beansG: b.beansG,
        milkMl: b.milkMl,
        co2G: b.co2G,
        splashCount: b.splashIds.length,
        deltaVsCoffee: b.co2G - baselineG,
      };
    }),
    stale,
    lastPollOkAt,
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(state));
}

function serveStatic(res: ServerResponse, publicDir: string, rel: string) {
  if (!publicDir) { res.statusCode = 404; res.end("not found"); return; }
  const safe = normalize(rel).replace(/^([./\\])+/, "");
  const full = join(publicDir, safe);
  if (!full.startsWith(publicDir) || !existsSync(full)) {
    res.statusCode = 404; res.end("not found"); return;
  }
  const mime = MIME[extname(full)] ?? "application/octet-stream";
  res.setHeader("Content-Type", mime);
  res.end(readFileSync(full));
}
