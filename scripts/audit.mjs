import Database from "better-sqlite3";
const db = new Database("data/kaffe.sqlite", { readonly: true });

const fmt = (r) => Object.values(r).map(v => String(v ?? "")).join("\t");

console.log("=== Per-machine coverage ===");
const cov = db.prepare(`
  SELECT machine_id,
         COUNT(*) AS total,
         MIN(local_date) AS earliest,
         MAX(local_date) AS latest,
         SUM(CASE WHEN product_key IS NULL THEN 1 ELSE 0 END) AS missing_key,
         COUNT(DISTINCT product_key) AS distinct_keys,
         COUNT(DISTINCT local_date) AS days
  FROM brews GROUP BY machine_id
`).all();
console.log("machine\ttotal\tearliest\tlatest\tmissing_key\tdistinct_keys\tdays");
for (const r of cov) console.log(fmt(r));

console.log("\n=== Brews per day (last 14 days) ===");
const daily = db.prepare(`
  SELECT local_date, COUNT(*) AS cups
  FROM brews
  WHERE local_date >= date('now','-14 days')
  GROUP BY local_date ORDER BY local_date
`).all();
for (const r of daily) console.log(`${r.local_date}\t${r.cups}`);

console.log("\n=== Brews per (machine, product_key) with unresolved product names ===");
const unresolved = db.prepare(`
  SELECT b.machine_id, b.product_key, b.drink_type, COUNT(*) AS cups
  FROM brews b
  LEFT JOIN products p ON p.machine_id = b.machine_id AND p.product_key = b.product_key
  WHERE p.name IS NULL AND b.product_key IS NOT NULL
  GROUP BY b.machine_id, b.product_key
  ORDER BY cups DESC
`).all();
if (unresolved.length === 0) {
  console.log("  (all product_keys resolve to a product name — clean)");
} else {
  console.log("machine\tkeyId\tdrink_type\tcups");
  for (const r of unresolved) console.log(fmt(r));
}

console.log("\n=== Products table size ===");
const ptot = db.prepare(`SELECT machine_id, COUNT(*) AS named_products FROM products GROUP BY machine_id`).all();
for (const r of ptot) console.log(fmt(r));

console.log("\n=== Sanity check vs machine counter ===");
const stored = db.prepare(`SELECT machine_id, SUM(beans_g) AS summed_g, COUNT(*) AS cups FROM brews GROUP BY machine_id`).all();
for (const r of stored) {
  console.log(`machine ${r.machine_id}: ${r.cups} cups, ${(r.summed_g / 1000).toFixed(2)} kg stored beans`);
}
