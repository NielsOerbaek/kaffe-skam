import { createServer as nodeCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { Store } from "./store.ts";
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

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function localDateString(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function sendTimeline(res: ServerResponse, opts: ServerOpts, q: URLSearchParams) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;

  // Weekly bucket: ?weeks=N → last N Mondays
  const weeksRaw = q.get("weeks");
  if (weeksRaw) {
    const wn = Number(weeksRaw);
    const weeks = Number.isFinite(wn) && wn > 0 && wn <= 53 ? Math.floor(wn) : 52;
    // Walk back N-1 weeks from this week's Monday
    const today = new Date();
    const thisMondayStr = Store.weekStartOf(localDateString(today));
    const [ty, tm, td] = thisMondayStr.split("-").map(Number);
    const thisMonday = new Date(ty!, (tm ?? 1) - 1, td ?? 1);
    const firstMonday = new Date(thisMonday.getTime() - (weeks - 1) * 7 * 86400_000);
    const sinceDate = localDateString(firstMonday);

    const series = opts.store.getWeeklyTotals(sinceDate);
    const have = new Map(series.map(s => [s.weekStart, s]));
    const filled: Array<{ weekStart: string; cups: number; co2_g: number }> = [];
    for (let i = 0; i < weeks; i++) {
      const ws = new Date(firstMonday.getTime() + i * 7 * 86400_000);
      const key = localDateString(ws);
      filled.push(have.get(key) ?? { weekStart: key, cups: 0, co2_g: 0 });
    }
    // Averages: count only weeks/days that had at least one cup so empty
    // calendar weeks (e.g. Christmas) don't drag the "average day" down.
    const activeWeeks = filled.filter(w => w.cups > 0);
    const totalCups = filled.reduce((s, w) => s + w.cups, 0);
    const totalCo2  = filled.reduce((s, w) => s + w.co2_g, 0);
    const avgWeekCups = activeWeeks.length ? totalCups / activeWeeks.length : 0;
    const avgWeekCo2  = activeWeeks.length ? totalCo2 / activeWeeks.length : 0;
    // Approximate active days at 5 per active week (Danish office calendar).
    // Empty days within an "active" week (e.g. weekend) don't get counted.
    const avgDayCups = activeWeeks.length ? totalCups / (activeWeeks.length * 5) : 0;
    const avgDayCo2  = activeWeeks.length ? totalCo2 / (activeWeeks.length * 5) : 0;

    res.end(JSON.stringify({
      bucket: "week",
      weeks,
      series: filled,
      averagePerWeek: { cups: avgWeekCups, co2_g: avgWeekCo2 },
      averagePerDay:  { cups: avgDayCups,  co2_g: avgDayCo2 },
      activeWeeks: activeWeeks.length,
    }));
    return;
  }

  // Daily bucket (default): ?days=N
  const daysRaw = Number(q.get("days") ?? "30");
  const days = Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365 ? Math.floor(daysRaw) : 30;
  const since = new Date(Date.now() - (days - 1) * 86400_000);
  const sinceDate = localDateString(since);
  const series = opts.store.getDailyTotals(sinceDate);
  const have = new Map(series.map(s => [s.date, s]));
  const filled: Array<{ date: string; cups: number; co2_g: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400_000);
    filled.push(have.get(localDateString(d)) ?? { date: localDateString(d), cups: 0, co2_g: 0 });
  }
  res.end(JSON.stringify({ bucket: "day", days, series: filled }));
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
  // compute a plain Coffee's CO₂ at the current calibrated dose. Looks up by
  // product name first ("Coffee" = machine button), falling back to the API
  // drink_type table.
  const ks = opts.config.machines.map(m => {
    const raw = opts.store.getMeta(`beans_calibration_k_${m.id}`);
    return raw == null ? 1.0 : Number(raw);
  });
  const avgK = ks.length ? ks.reduce((s, k) => s + k, 0) / ks.length : 1.0;
  const coffeeBeans = opts.config.beansByProduct["Coffee"]
    ?? opts.config.beansDefaultsG["COFFEE"]
    ?? 7;
  const baselineG = coffeeBeans * avgK * opts.config.co2.beansFactorGPerG;

  const lastPollOkAt = opts.store.getMeta("last_poll_ok_at");
  const stale = lastPollOkAt
    ? (Date.now() - new Date(lastPollOkAt).getTime()) > 60_000
    : false;

  const state: ApiState = {
    locationName: opts.config.locationName,
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
