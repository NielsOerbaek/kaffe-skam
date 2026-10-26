import Database from "better-sqlite3";
const db = new Database("/opt/kaffe-skam/data/kaffe.sqlite", { readonly: true });

// Compute the Europe/Copenhagen UTC offset (in seconds) for an instant.
// Handles CET/CEST transitions automatically.
function cphOffsetSec(date) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUtc - date.getTime()) / 1000;
}

const rows = db.prepare(`
  SELECT json_extract(raw_json,'$.machineTimestamp') AS mt,
         json_extract(raw_json,'$.serverTimestamp')  AS st
  FROM brews
  WHERE json_extract(raw_json,'$.machineTimestamp') IS NOT NULL
    AND json_extract(raw_json,'$.serverTimestamp')  IS NOT NULL
`).all();

const lags = [];
for (const r of rows) {
  const server = new Date(r.st);           // UTC (has Z)
  const offset = cphOffsetSec(server);     // CET=+3600, CEST=+7200
  // machineTimestamp is local wall-clock in Europe/Copenhagen; convert to UTC.
  const m = r.mt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) continue;
  const machineUtcMs = Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]) - offset * 1000;
  const lagSec = (server.getTime() - machineUtcMs) / 1000;
  lags.push(lagSec);
}

lags.sort((a,b) => a-b);
const q = p => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
const mean = lags.reduce((s,x)=>s+x,0) / lags.length;
const std  = Math.sqrt(lags.reduce((s,x)=>s+(x-mean)**2,0) / lags.length);

console.log(`n = ${lags.length} brews`);
console.log(`min ............ ${lags[0].toFixed(1)} s`);
console.log(`p05 ............ ${q(0.05).toFixed(1)} s`);
console.log(`p25 ............ ${q(0.25).toFixed(1)} s`);
console.log(`p50 (median) ... ${q(0.50).toFixed(1)} s`);
console.log(`p75 ............ ${q(0.75).toFixed(1)} s`);
console.log(`p90 ............ ${q(0.90).toFixed(1)} s`);
console.log(`p95 ............ ${q(0.95).toFixed(1)} s`);
console.log(`p99 ............ ${q(0.99).toFixed(1)} s`);
console.log(`max ............ ${lags[lags.length-1].toFixed(1)} s`);
console.log(`mean ........... ${mean.toFixed(1)} s`);
console.log(`stddev ......... ${std.toFixed(1)} s`);

console.log("\nDistribution:");
const buckets = [[-1e9,30],[30,45],[45,60],[60,75],[75,90],[90,120],[120,180],[180,300],[300,600],[600,1800],[1800,1e9]];
for (const [lo, hi] of buckets) {
  const n = lags.filter(x => x >= lo && x < hi).length;
  const pct = (n / lags.length * 100);
  const bar = "█".repeat(Math.round(pct / 100 * 60));
  const label = `${lo <= -1e8 ? "  <" : `${String(lo).padStart(4)}–`}${hi >= 1e8 ? "  ≥" : String(hi).padStart(4)}`;
  console.log(`  ${label}  ${String(n).padStart(5)}  ${pct.toFixed(1).padStart(5)}%  ${bar}`);
}

// How many brews land within X seconds of the brew finishing?
console.log("\nCumulative:");
for (const cut of [30, 45, 60, 75, 90, 120, 180, 300]) {
  const n = lags.filter(x => x <= cut).length;
  console.log(`  ≤ ${String(cut).padStart(3)}s  ${(n / lags.length * 100).toFixed(1)}%`);
}
