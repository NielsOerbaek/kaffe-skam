import type { EversysClient } from "./api.ts";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";
import type { ProductHistory, PendingBrew } from "./types.ts";
import { mergeStep } from "./merge.ts";
import { defaultBeansG, applyCalibration, recalibrate } from "./beans.ts";
import { co2ForBrew } from "./co2.ts";

export interface PollerOpts {
  api: EversysClient;
  store: Store;
  config: Config;
}

// Local-time ISO-like string ("YYYY-MM-DDTHH:MM:SS"). Same convention used in merge.ts.
// Intentionally does NOT append "Z" — timestamps are machine local time, not UTC.
function toLocalISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class Poller {
  private readonly api: EversysClient;
  private readonly store: Store;
  private readonly cfg: Config;

  constructor(opts: PollerOpts) {
    this.api = opts.api;
    this.store = opts.store;
    this.cfg = opts.config;
  }

  async bootstrap(): Promise<void> {
    if (this.store.getMeta("last_seen_id") != null) return;
    const recent = await this.api.fetchBrewsAfter(null, 1);
    const id = recent[0]?.id ?? 0;
    this.store.setMeta("last_seen_id", String(id));
    this.store.setMeta("beans_calibration_k", "1.0");
    // Initialise calibration anchor at zero so the first tickCounters can compute a delta.
    this.store.setMeta("beans_calibration_anchor_kg", "0");
    this.store.setMeta("beans_calibration_anchor_summed_g", "0");
    this.store.setMeta("beans_calibration_anchor_brew_count", "0");
  }

  async tickBrews(nowMs: number = Date.now()): Promise<void> {
    const lastSeen = Number(this.store.getMeta("last_seen_id") ?? "0");
    const k = Number(this.store.getMeta("beans_calibration_k") ?? "1.0");

    // Flush stale pending from the PREVIOUS tick before fetching new brews.
    let pending = this.store.getPending();
    if (pending && new Date(pending.expiresAt).getTime() <= nowMs) {
      this.store.insertBrew(pending);
      this.store.clearPending();
      pending = null;
    }

    const brews = await this.api.fetchBrewsAfter(lastSeen, 100);
    let newLastSeen = lastSeen;

    for (const ph of brews) {
      const r = mergeStep(ph, pending, this.cfg.polling.splashWindowMs, {
        toPending: (raw) => this.toPending(raw, k),
      });
      if (r.commit) this.store.insertBrew(r.commit);
      pending = r.newPending;
      newLastSeen = ph.id;
    }

    if (pending) this.store.setPending(pending);
    else this.store.clearPending();

    if (newLastSeen !== lastSeen) this.store.setMeta("last_seen_id", String(newLastSeen));
    this.store.setMeta("last_poll_ok_at", new Date(nowMs).toISOString());
  }

  async tickCounters(): Promise<void> {
    const c = await this.api.fetchCounters();
    this.store.setMeta("last_counter_check_at", new Date().toISOString());

    const counterKg = c.beans.totalQuantity;
    const anchorKgStr = this.store.getMeta("beans_calibration_anchor_kg");
    const anchorSummedStr = this.store.getMeta("beans_calibration_anchor_summed_g");
    const summedNow = this.summedBeansGSinceEpoch();

    if (anchorKgStr == null || anchorSummedStr == null) {
      this.store.setMeta("beans_calibration_anchor_kg", String(counterKg));
      this.store.setMeta("beans_calibration_anchor_summed_g", String(summedNow));
      this.store.setMeta("beans_calibration_anchor_brew_count", String(this.brewCountTotal()));
      return;
    }

    const anchorKg = Number(anchorKgStr);
    const anchorSummed = Number(anchorSummedStr);
    const brewsSinceAnchor = this.brewCountTotal() - Number(this.store.getMeta("beans_calibration_anchor_brew_count") ?? "0");
    const summedSinceAnchor = summedNow - anchorSummed;
    const actualGramsDelta = (counterKg - anchorKg) * 1000;
    const currentK = Number(this.store.getMeta("beans_calibration_k") ?? "1.0");

    const newK = recalibrate(
      { brewsSinceAnchor, summedBeansGSinceAnchor: summedSinceAnchor, actualGramsDelta, currentK },
      this.cfg.calibration,
    );

    if (newK != null) {
      this.store.setMeta("beans_calibration_k", String(newK));
      this.store.setMeta("beans_calibration_anchor_kg", String(counterKg));
      this.store.setMeta("beans_calibration_anchor_summed_g", String(summedNow));
      this.store.setMeta("beans_calibration_anchor_brew_count", String(this.brewCountTotal()));
    }
  }

  private toPending(ph: ProductHistory, k: number): PendingBrew {
    const machineTs = ph.machineTimestamp;
    const base = defaultBeansG(ph.type, ph.isDouble, this.cfg.beansDefaultsG);
    const beansG = applyCalibration(base, k);
    const milkMl = ph.milk?.consumption ?? 0;
    const co2G = co2ForBrew(beansG, milkMl, this.cfg.co2);
    const expiresAt = toLocalISO(new Date(new Date(machineTs).getTime() + this.cfg.polling.splashWindowMs));
    return {
      id: ph.id,
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

  private summedBeansGSinceEpoch(): number {
    const db = (this.store as any).db;
    const r = db.prepare(`SELECT COALESCE(SUM(beans_g), 0) AS total FROM brews`).get();
    const committed = r.total as number;
    // Include the pending brew so calibration accounts for all observed shots.
    const pending = this.store.getPending();
    return committed + (pending?.beansG ?? 0);
  }

  private brewCountTotal(): number {
    const db = (this.store as any).db;
    const r = db.prepare(`SELECT COUNT(*) AS n FROM brews`).get();
    const committed = r.n as number;
    // Include the pending brew so calibration counts all observed shots.
    const pending = this.store.getPending();
    return committed + (pending != null ? 1 : 0);
  }
}
