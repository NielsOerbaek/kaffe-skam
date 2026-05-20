import { createServer as nodeCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";
import type { ApiState } from "./types.ts";
import { humanizeType, deltaVsCoffee } from "./co2.ts";

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
  const url = req.url ?? "/";

  if (url === "/api/state") return sendState(res, opts);
  if (url === "/") return serveStatic(res, opts.publicDir, "index.html");
  if (url.startsWith("/static/")) {
    const rel = url.slice("/static/".length);
    return serveStatic(res, opts.publicDir, rel);
  }
  res.statusCode = 404; res.end("not found");
}

function sendState(res: ServerResponse, opts: ServerOpts) {
  const now = new Date();
  const localDate = now.toISOString().slice(0, 10);
  const localMonth = now.toISOString().slice(0, 7);

  const today = opts.store.getTodayTotals(localDate);
  const month = opts.store.getMonthTotals(localMonth);
  const recent = opts.store.getRecentBrews(6);

  const floorByMachine = new Map(opts.config.machines.map(m => [m.id, m.floor]));

  const lastPollOkAt = opts.store.getMeta("last_poll_ok_at");
  const stale = lastPollOkAt
    ? (Date.now() - new Date(lastPollOkAt).getTime()) > 60_000
    : false;

  const state: ApiState = {
    today: { cups: today.cups, co2_g: today.co2_g },
    month: { cups: month.cups, co2_g: month.co2_g },
    lastBrews: recent.map(b => ({
      type: b.drinkType,
      displayName: humanizeType(b.drinkType),
      floor: floorByMachine.get(b.machineId) ?? "?",
      machineTs: b.machineTs,
      beansG: b.beansG,
      milkMl: b.milkMl,
      co2G: b.co2G,
      splashCount: b.splashIds.length,
      deltaVsCoffee: deltaVsCoffee(b.co2G, opts.config.co2),
    })),
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
