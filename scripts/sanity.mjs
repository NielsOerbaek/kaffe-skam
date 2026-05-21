import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter(l => l.trim() && !l.startsWith("#"))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TOKEN = env.EVERSYS_TOKEN;
const machines = env.EVERSYS_MACHINES.split(",").map(s => {
  const [id, ...rest] = s.split(":");
  return { id: Number(id.trim()), floor: rest.join(":").trim() };
});

const db = new Database("data/kaffe.sqlite", { readonly: true });

console.log("Machine totals (since each machine's lastReset):\n");
console.log("ID      Floor      Cups (API stats)  Beans kg (counter)  g/cup (actual)   our default × k   match");
console.log("─".repeat(110));
for (const m of machines) {
  // counters: total beans kg
  const cR = await fetch(`https://api.eversys-telemetry.com/v3/machines/machine-counters/${m.id}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const c = await cR.json();
  // stats: total products since reset is derivable from "this month + months ago" — but we have a better proxy from raw counts.
  // Use product-counters total = sum of coffee + milk + tea + powder. Actually we just want total brew count.
  const ctrR = await fetch(`https://api.eversys-telemetry.com/v3/machines/${m.id}/product-counters`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const ctr = await ctrR.json();
  const ctrArr = Array.isArray(ctr) ? ctr : [ctr];
  const totalBrews = ctrArr.reduce((s, x) => s + (x.coffee||0) + (x.milk||0) + (x.tea||0) + (x.powder||0) + (x.foam||0) + (x.steam||0), 0);
  const beansKg = c.beans?.totalQuantity ?? 0;
  const actualGPerCup = totalBrews > 0 ? (beansKg * 1000) / totalBrews : 0;

  const k = Number(db.prepare("SELECT value FROM meta WHERE key = ?").get(`beans_calibration_k_${m.id}`)?.value ?? "1.0");
  const ourDefault = 7 * k;

  console.log(
    `${m.id}  ${m.floor.padEnd(10)}  ${String(totalBrews).padStart(16)}  ${beansKg.toFixed(2).padStart(18)}  ${actualGPerCup.toFixed(2).padStart(14)}  ${ourDefault.toFixed(2).padStart(15)}  k=${k.toFixed(3)}`
  );
}
