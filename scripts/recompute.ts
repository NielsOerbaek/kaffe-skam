// Recompute beansG + milkMl + co2G for every stored brew using the CURRENT
// config (beansByProduct, zeroMilkProducts, calibration k).
//
// Run after a config change that affects per-brew calculation (e.g. new
// product-name table, tea overrides). Idempotent.
//
// Usage:  npm run recompute

import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { beansGForBrew, applyCalibration } from "../src/beans.ts";
import { co2ForBrew } from "../src/co2.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const cfg = loadConfig(ROOT);
  const store = new Store(join(ROOT, "data", "kaffe.sqlite"));
  const db = (store as any).db;

  const ks = new Map<number, number>();
  for (const m of cfg.machines) {
    const raw = store.getMeta(`beans_calibration_k_${m.id}`);
    ks.set(m.id, raw == null ? 1.0 : Number(raw));
  }

  const rows = db.prepare(
    `SELECT id, machine_id, product_key, drink_type, is_double, raw_json FROM brews`
  ).all() as Array<{
    id: number; machine_id: number; product_key: number | null;
    drink_type: string; is_double: 0 | 1; raw_json: string;
  }>;

  console.log(`recomputing ${rows.length} brews…`);

  const upd = db.prepare(
    `UPDATE brews SET beans_g = ?, milk_ml = ?, co2_g = ? WHERE machine_id = ? AND id = ?`
  );

  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const productName = r.product_key != null
        ? store.getProductName(r.machine_id, r.product_key)
        : null;

      const baseBeans = beansGForBrew({
        productName,
        type: r.drink_type as any,
        isDouble: r.is_double,
        byProduct: cfg.beansByProduct,
        byType: cfg.beansDefaultsG,
      });
      const k = ks.get(r.machine_id) ?? 1.0;
      const beansG = applyCalibration(baseBeans, k);

      let milkMl: number;
      if (productName != null && cfg.milkByProduct[productName] != null) {
        milkMl = cfg.milkByProduct[productName]!;
      } else if (productName != null && cfg.zeroMilkProducts.includes(productName)) {
        milkMl = 0;
      } else {
        try {
          const raw = JSON.parse(r.raw_json) as { milk?: { consumption?: number } | null };
          milkMl = raw.milk?.consumption ?? 0;
        } catch { milkMl = 0; }
      }

      const co2G = co2ForBrew(beansG, milkMl, cfg.co2);
      upd.run(beansG, milkMl, co2G, r.machine_id, r.id);
      updated++;
    }
  });
  tx();
  console.log(`updated ${updated} rows.`);
  store.close();
}

main();
