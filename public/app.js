const $ = (id) => document.getElementById(id);
const REFRESH_MS = 3000;

// Danish display names for Eversys drink-type enum.
const DA_DRINK = {
  RISTRETTO: "Ristretto",
  ESPRESSO: "Espresso",
  COFFEE: "Kaffe",
  FILTER_COFFEE: "Filterkaffe",
  AMERICANO: "Americano",
  COFFEE_POT: "Kaffekande",
  FILTER_COFFEE_POT: "Filterkande",
  HOT_WATER: "Varmt vand",
  MANUAL_STEAM: "Damp",
  AUTO_STEAM: "Damp",
  EVERFOAM: "Everfoam",
  MILK_COFFEE: "Mælkekaffe",
  CAPPUCCINO: "Cappuccino",
  ESPRESSO_MACCHIATO: "Espresso macchiato",
  LATTE_MACCHIATO: "Latte macchiato",
  MILK: "Mælk",
  MILK_FOAM: "Mælkeskum",
  POWDER: "Pulver",
  WHITE_AMERICANO: "Hvid americano",
  HOT_WATER_WITH_MILK: "Varmt vand m. mælk",
  UNRESOLVED: "Ukendt",
};

function fmtG(g) {
  if (g == null) return "—";
  if (g >= 1000) return (g / 1000).toFixed(2).replace(".", ",") + " kg";
  return Math.round(g) + " g";
}
function fmtDriveKm(co2_g) {
  const km = co2_g / 200;
  if (!co2_g) return " ";
  if (km >= 0.1) return `≈ ${km.toFixed(1).replace(".", ",")} km i bil`;
  return "≈ et par meter i bil";
}
function fmtClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}.${p(d.getMinutes())}`;
}

const DA_MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
function fmtBrewTs(machineTs) {
  // "2026-05-20T12:22:54" → "20. maj kl. 12.22"
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(machineTs);
  if (!m) return machineTs;
  const month = DA_MONTHS[parseInt(m[2], 10) - 1] ?? m[2];
  return `${parseInt(m[3], 10)}. ${month} kl. ${m[4]}.${m[5]}`;
}

async function refresh() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error("status " + r.status);
    const s = await r.json();
    render(s);
    $("chip-status").textContent = s.stale ? "Forældet" : "Live";
  } catch (e) {
    $("stale-badge").hidden = false;
    $("chip-status").textContent = "Offline";
  }
}

function render(s) {
  $("today-co2").textContent = fmtG(s.today.co2_g);
  $("today-equiv").textContent = fmtDriveKm(s.today.co2_g);
  $("today-cups").textContent = s.today.cups;
  $("month-co2").textContent = fmtG(s.month.co2_g);
  $("chip-time").textContent = fmtClock();
  $("stale-badge").hidden = !s.stale;

  if (!s.lastBrew) {
    $("last-label").textContent = "Seneste bryg";
    $("drink-name").textContent = "Venter på første kop…";
    $("composition").innerHTML = " ";
    $("delta").textContent = "—";
    $("vs").textContent = "";
    $("coffee-bar").style.width = "0%";
    $("brew-bar").style.width = "0%";
    $("coffee-v").textContent = "—";
    $("brew-v").textContent = "—";
    return;
  }

  const b = s.lastBrew;
  // "2026-05-20T12:22:54" → "20. maj kl. 12.22"
  const ts = fmtBrewTs(b.machineTs);
  $("last-label").textContent = "Seneste bryg · " + ts;
  $("drink-name").textContent = DA_DRINK[b.type] ?? b.displayName;

  const parts = [`${b.beansG.toFixed(1).replace(".", ",")} g kaffe`];
  if (b.milkMl > 0) parts.push(`${Math.round(b.milkMl)} ml mælk`);
  if (b.splashCount === 1) parts.push("+ 1 skvæt");
  else if (b.splashCount > 1) parts.push(`+ ${b.splashCount} skvæt`);
  $("composition").textContent = parts.join("  ·  ");

  const d = b.deltaVsCoffee;
  $("delta").textContent = (d >= 0 ? "+" : "−") + fmtG(Math.abs(d));
  $("delta").classList.toggle("up", d >= 0);
  $("delta").classList.toggle("down", d < 0);

  const baseline = b.co2G - d;
  $("coffee-v").textContent = fmtG(baseline);
  $("brew-v").textContent   = fmtG(b.co2G);
  const max = Math.max(baseline, b.co2G, 1);
  $("coffee-bar").style.width = `${(baseline / max) * 100}%`;
  $("brew-bar").style.width   = `${(b.co2G / max) * 100}%`;

  $("vs").textContent = `vs. almindelig kaffe (${fmtG(baseline)})`;
}

refresh();
setInterval(refresh, REFRESH_MS);
