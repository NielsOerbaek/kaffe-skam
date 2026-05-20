import type { EversysClient } from "./api.ts";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";
import type { ProductHistory, PendingBrew } from "./types.ts";
import { mergeStep } from "./merge.ts";
import { beansGForBrew, applyCalibration, recalibrate } from "./beans.ts";
import { co2ForBrew } from "./co2.ts";

export interface MachineWiring {
  client: EversysClient;
  machineId: number;
  floor: string;
}

export interface PollerOpts {
  machines: MachineWiring[];
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
  private readonly machines: MachineWiring[];
  private readonly store: Store;
  private readonly cfg: Config;

  constructor(opts: PollerOpts) {
    this.machines = opts.machines;
    this.store = opts.store;
    this.cfg = opts.config;
  }

  // Per-machine meta keys
  private keyLastSeen(machineId: number)        { return `last_seen_id_${machineId}`; }
  private keyK(machineId: number)               { return `beans_calibration_k_${machineId}`; }
  private keyAnchorKg(machineId: number)        { return `beans_calibration_anchor_kg_${machineId}`; }
  private keyAnchorSummedG(machineId: number)   { return `beans_calibration_anchor_summed_g_${machineId}`; }
  private keyAnchorBrewCount(machineId: number) { return `beans_calibration_anchor_brew_count_${machineId}`; }

  async bootstrap(): Promise<void> {
    for (const m of this.machines) {
      if (this.store.getMeta(this.keyLastSeen(m.machineId)) != null) continue;
      const recent = await m.client.fetchBrewsAfter(null, 1);
      const id = recent[0]?.id ?? 0;
      this.store.setMeta(this.keyLastSeen(m.machineId), String(id));
      this.store.setMeta(this.keyK(m.machineId), "1.0");
      this.store.setMeta(this.keyAnchorKg(m.machineId), "0");
      this.store.setMeta(this.keyAnchorSummedG(m.machineId), "0");
      this.store.setMeta(this.keyAnchorBrewCount(m.machineId), "0");
    }
  }

  async tickBrews(nowMs: number = Date.now()): Promise<void> {
    for (const m of this.machines) {
      await this.tickOneMachine(m, nowMs);
    }
    this.store.setMeta("last_poll_ok_at", new Date(nowMs).toISOString());
  }

  private async tickOneMachine(m: MachineWiring, nowMs: number): Promise<void> {
    const lastSeenKey = this.keyLastSeen(m.machineId);
    const lastSeen = Number(this.store.getMeta(lastSeenKey) ?? "0");
    const k = Number(this.store.getMeta(this.keyK(m.machineId)) ?? "1.0");

    // Flush stale pending from this machine's previous tick before fetching new brews.
    let pending = this.store.getPending(m.machineId);
    if (pending && new Date(pending.expiresAt).getTime() <= nowMs) {
      this.store.insertBrew(pending);
      this.store.clearPending(m.machineId);
      pending = null;
    }

    const brews = await m.client.fetchBrewsAfter(lastSeen, 100);
    let newLastSeen = lastSeen;

    for (const ph of brews) {
      const r = mergeStep(ph, pending, this.cfg.polling.splashWindowMs, {
        toPending: (raw) => this.toPending(raw, k, m.machineId),
        applySplash: (pendingBrew, splash) => this.applySplash(pendingBrew, splash),
      });
      if (r.commit) this.store.insertBrew(r.commit);
      pending = r.newPending;
      newLastSeen = ph.id;
    }

    if (pending) this.store.setPending(pending);
    else this.store.clearPending(m.machineId);

    if (newLastSeen !== lastSeen) this.store.setMeta(lastSeenKey, String(newLastSeen));
  }

  async tickCounters(): Promise<void> {
    for (const m of this.machines) {
      await this.tickCountersOne(m);
    }
    this.store.setMeta("last_counter_check_at", new Date().toISOString());
  }

  private async tickCountersOne(m: MachineWiring): Promise<void> {
    const c = await m.client.fetchCounters();
    const counterKg = c.beans.totalQuantity;
    const summedNow = this.summedBeansGForMachine(m.machineId);
    const countNow = this.brewCountForMachine(m.machineId);

    const anchorKgStr        = this.store.getMeta(this.keyAnchorKg(m.machineId));
    const anchorSummedStr    = this.store.getMeta(this.keyAnchorSummedG(m.machineId));
    const anchorBrewCountStr = this.store.getMeta(this.keyAnchorBrewCount(m.machineId));

    if (anchorKgStr == null || anchorSummedStr == null || anchorBrewCountStr == null) {
      this.store.setMeta(this.keyAnchorKg(m.machineId), String(counterKg));
      this.store.setMeta(this.keyAnchorSummedG(m.machineId), String(summedNow));
      this.store.setMeta(this.keyAnchorBrewCount(m.machineId), String(countNow));
      return;
    }

    const anchorKg     = Number(anchorKgStr);
    const anchorSummed = Number(anchorSummedStr);
    const anchorCount  = Number(anchorBrewCountStr);
    const brewsSinceAnchor = countNow - anchorCount;
    const summedSinceAnchor = summedNow - anchorSummed;
    const actualGramsDelta = (counterKg - anchorKg) * 1000;
    const currentK = Number(this.store.getMeta(this.keyK(m.machineId)) ?? "1.0");

    const newK = recalibrate(
      { brewsSinceAnchor, summedBeansGSinceAnchor: summedSinceAnchor, actualGramsDelta, currentK },
      this.cfg.calibration,
    );

    if (newK != null) {
      this.store.setMeta(this.keyK(m.machineId), String(newK));
      this.store.setMeta(this.keyAnchorKg(m.machineId), String(counterKg));
      this.store.setMeta(this.keyAnchorSummedG(m.machineId), String(summedNow));
      this.store.setMeta(this.keyAnchorBrewCount(m.machineId), String(countNow));
    }
  }

  // Fold a splash brew into the pending one: add milk (converted via
  // milkUnitMl) and recompute the CO₂ from the new total. beansG stays
  // — only the primary brew dispenses beans.
  private applySplash(pending: PendingBrew, splash: ProductHistory): PendingBrew {
    const rawConsumption = splash.milk?.consumption ?? 0;
    const addedMl = rawConsumption * this.cfg.milkUnitMl;
    const milkMl = pending.milkMl + addedMl;
    const co2G = co2ForBrew(pending.beansG, milkMl, this.cfg.co2);
    return {
      ...pending,
      milkMl,
      co2G,
      splashIds: [...pending.splashIds, splash.id],
    };
  }

  private toPending(ph: ProductHistory, k: number, machineId: number): PendingBrew {
    const machineTs = ph.machineTimestamp;
    const productKey = typeof ph.keyId === "number" ? ph.keyId : null;
    const productName = productKey != null ? this.store.getProductName(machineId, productKey) : null;

    const base = beansGForBrew({
      productName,
      type: ph.type,
      isDouble: ph.isDouble,
      byProduct: this.cfg.beansByProduct,
      byType: this.cfg.beansDefaultsG,
    });
    const beansG = applyCalibration(base, k);
    // Milk volume: explicit milkByProduct override wins; legacy zeroMilkProducts
    // forces 0; otherwise multiply the API's unitless milk.consumption by
    // milkUnitMl (calibrated ≈ 12.5 ml per unit).
    let milkMl: number;
    if (productName != null && this.cfg.milkByProduct[productName] != null) {
      milkMl = this.cfg.milkByProduct[productName]!;
    } else if (productName != null && this.cfg.zeroMilkProducts.includes(productName)) {
      milkMl = 0;
    } else {
      milkMl = (ph.milk?.consumption ?? 0) * this.cfg.milkUnitMl;
    }
    const co2G = co2ForBrew(beansG, milkMl, this.cfg.co2);
    const expiresAt = toLocalISO(new Date(new Date(machineTs).getTime() + this.cfg.polling.splashWindowMs));
    return {
      id: ph.id,
      machineId,
      productKey,
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

  // Fetch and persist the product-name catalog for every configured machine.
  // The Eversys API uses two different indexes for the same product in two
  // different endpoints: /product-parameters returns names keyed by
  // `productId`, but /products (brew history) reports `keyId = productId + 1`.
  // We store names under the `keyId`, since that's what brews carry, so the
  // join in getRecentBrews / getByDrinkType just works.
  //
  // productNameOverrides in config are also keyed by keyId; applied last so
  // they win over the API's name.
  async refreshProducts(): Promise<void> {
    for (const m of this.machines) {
      for (const side of ["LEFT", "RIGHT"] as const) {
        try {
          const products = await m.client.fetchProducts(side);
          for (const p of products) {
            this.store.upsertProduct(m.machineId, p.productId + 1, p.name);
          }
        } catch (e) {
          console.warn(`refreshProducts ${m.machineId}/${side} failed:`, (e as Error).message);
        }
      }
      for (const [keyStr, name] of Object.entries(this.cfg.productNameOverrides)) {
        const keyId = Number(keyStr);
        if (Number.isInteger(keyId)) this.store.upsertProduct(m.machineId, keyId, name);
      }
    }
  }

  private summedBeansGForMachine(machineId: number): number {
    const db = (this.store as any).db;
    const r = db.prepare(`SELECT COALESCE(SUM(beans_g), 0) AS total FROM brews WHERE machine_id = ?`).get(machineId);
    const committed = r.total as number;
    const pending = this.store.getPending(machineId);
    return committed + (pending?.beansG ?? 0);
  }

  private brewCountForMachine(machineId: number): number {
    const db = (this.store as any).db;
    const r = db.prepare(`SELECT COUNT(*) AS n FROM brews WHERE machine_id = ?`).get(machineId);
    const committed = r.n as number;
    const pending = this.store.getPending(machineId);
    return committed + (pending != null ? 1 : 0);
  }
}
