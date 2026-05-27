// Backfill historical brews for every configured machine.
//
// Usage:
//   npm run backfill          (defaults to 30 days)
//   npm run backfill -- 7     (7 days)
//
// Idempotent: brews are keyed by (machine_id, id) with INSERT OR IGNORE,
// so re-running just no-ops on already-stored rows.
//
// Stop the live service first if it is running on the same DB; better-sqlite3
// uses WAL mode so concurrent writes work, but stopping avoids surprises.

import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { ApiRateLimitError, ApiError } from "../src/api.ts";
import { TokenManager } from "../src/auth.ts";
import { mergeStep } from "../src/merge.ts";
import { defaultBeansG, applyCalibration } from "../src/beans.ts";
import { co2ForBrew } from "../src/co2.ts";
import type { ProductHistory, PendingBrew, Brew } from "../src/types.ts";
import type { Config } from "../src/config.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function toLocalISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function buildPending(ph: ProductHistory, cfg: Config, machineId: number): PendingBrew {
  const machineTs = ph.machineTimestamp;
  const base = defaultBeansG(ph.type, ph.isDouble, cfg.beansDefaultsG);
  const beansG = applyCalibration(base, 1.0); // backfill uses k=1; live calibration adjusts going forward
  const milkMl = ph.milk?.consumption ?? 0;
  const co2G = co2ForBrew(beansG, milkMl, cfg.co2);
  const expiresAt = toLocalISO(new Date(new Date(machineTs).getTime() + cfg.polling.splashWindowMs));
  return {
    id: ph.id,
    machineId,
    machineTs,
    localDate: machineTs.slice(0, 10),
    localMonth: machineTs.slice(0, 7),
    drinkType: ph.type,
    isDouble: ph.isDouble,
    beansG,
    milkMl,
    co2G,
    splashIds: [],
    rawJson: JSON.stringify(ph),
    expiresAt,
  };
}

// Direct, time-windowed fetch. We can't reuse EversysClient.fetchBrewsAfter
// because it switches between DESC (no afterId) and ASC (with afterId) which
// breaks pagination when seeding the loop.
async function fetchBrewsInRange(
  cfg: Config,
  auth: TokenManager,
  machineId: number,
  t1: string,
  t2: string,
): Promise<ProductHistory[]> {
  const all: ProductHistory[] = [];
  let afterId: number | undefined;
  const limit = 500;
  for (let page = 0; page < 200; page++) {
    const qs = new URLSearchParams({
      sortOrder: "ASC",
      limit: String(limit),
      t1,
      t2,
    });
    if (afterId !== undefined) qs.set("afterId", String(afterId));
    const url = `${cfg.api.baseUrl}/v3/machines/${machineId}/products?${qs}`;
    let attempts = 0;
    let chunk: ProductHistory[] | null = null;
    while (attempts < 6) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.getAccessToken()}` } });
      if (r.status === 429) {
        attempts++;
        const wait = 1000 * Math.pow(2, attempts);
        process.stdout.write(`(429, sleeping ${wait}ms) `);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      if (!r.ok) throw new ApiError(`HTTP ${r.status} for ${url}`, r.status);
      chunk = await r.json() as ProductHistory[];
      break;
    }
    if (chunk == null) throw new ApiRateLimitError();
    if (chunk.length === 0) break;
    all.push(...chunk);
    afterId = chunk[chunk.length - 1]!.id;
    process.stdout.write(`page ${page + 1}: +${chunk.length} (total ${all.length})  `);
    if (chunk.length < limit) break;
    await new Promise(res => setTimeout(res, 200)); // friendly pacing
  }
  process.stdout.write("\n");
  return all;
}

async function main() {
  const daysArg = process.argv[2];
  const days = daysArg ? parseInt(daysArg, 10) : 30;
  if (!Number.isInteger(days) || days <= 0 || days > 365) {
    console.error(`days must be 1-365, got "${daysArg}"`); process.exit(2);
  }

  const cfg = loadConfig(ROOT);
  mkdirSync(join(ROOT, "data"), { recursive: true });
  const store = new Store(join(ROOT, "data", "kaffe.sqlite"));
  const tokenManager = new TokenManager({
    storePath: join(ROOT, "data", "eversys-tokens.json"),
    authUrl: cfg.authUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  tokenManager.load();

  const now = new Date();
  const since = new Date(now.getTime() - days * 86400_000);
  const t1 = toLocalISO(since);
  const t2 = toLocalISO(now);
  console.log(`backfilling ${days} day(s): ${t1} → ${t2}`);
  console.log(`machines: ${cfg.machines.map(m => `${m.id} (${m.floor})`).join(", ")}\n`);

  let totalCommitted = 0;
  for (const m of cfg.machines) {
    console.log(`══ machine ${m.id} (${m.floor}) ══`);
    const brews = await fetchBrewsInRange(cfg, tokenManager, m.id, t1, t2);
    brews.sort((a, b) => a.machineTimestamp.localeCompare(b.machineTimestamp));
    console.log(`  fetched ${brews.length} brews`);

    let pending: PendingBrew | null = null;
    let committed = 0;
    for (const ph of brews) {
      const r = mergeStep(ph, pending, cfg.polling.splashWindowMs, {
        toPending: (raw) => buildPending(raw, cfg, m.id),
      });
      if (r.commit) {
        store.insertBrew(r.commit as Brew);
        committed++;
      }
      pending = r.newPending;
    }
    if (pending) {
      store.insertBrew(pending as Brew);
      committed++;
    }
    console.log(`  committed ${committed} brews after splash-merge\n`);
    totalCommitted += committed;
  }

  console.log(`done. inserted/no-op'd ${totalCommitted} brews across ${cfg.machines.length} machine(s).`);
  store.close();
}

main().catch(e => { console.error("backfill failed:", e); process.exit(1); });
