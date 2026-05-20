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
function escape(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function setBigNumber(el, g) {
  if (g == null) { el.textContent = "—"; return; }
  el.innerHTML = `${escape(fmtG(g))}<span class="unit-tail">&nbsp;CO₂</span>`;
}
function smallNumberHtml(g) {
  return `${escape(fmtG(g))}<span class="unit-tail">&nbsp;CO₂</span>`;
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
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(machineTs);
  if (!m) return machineTs;
  const month = DA_MONTHS[parseInt(m[2], 10) - 1] ?? m[2];
  return `${parseInt(m[3], 10)}. ${month} kl. ${m[4]}.${m[5]}`;
}
function fmtBrewTime(machineTs) {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):/.exec(machineTs);
  return m ? `${m[1]}.${m[2]}` : "—";
}

// Delta as percentage of baseline. Rounded to nearest %; uses minus sign for negatives.
function fmtDeltaPct(delta, baseline) {
  if (!baseline || !isFinite(baseline)) return "—";
  const pct = Math.round((delta / baseline) * 100);
  if (pct === 0) return "±0 %";
  return (pct > 0 ? "+" : "−") + Math.abs(pct) + " %";
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
  setBigNumber($("today-co2"), s.today.co2_g);
  $("today-equiv").textContent = fmtDriveKm(s.today.co2_g);
  $("today-cups").textContent = s.today.cups;
  $("month-co2").textContent = fmtG(s.month.co2_g);
  $("chip-time").textContent = fmtClock();
  $("stale-badge").hidden = !s.stale;

  const brews = s.lastBrews ?? [];
  const latest = brews[0];
  const previous = brews.slice(1);

  if (!latest) {
    $("last-label").textContent = "Seneste bryg";
    $("drink-name").textContent = "Venter på første kop…";
    $("composition").innerHTML = " ";
    $("brew-co2").textContent = "—";
    $("delta").textContent = "";
    $("vs").textContent = "";
    renderPrevious([]);
    return;
  }

  const ts = fmtBrewTs(latest.machineTs);
  $("last-label").textContent = `Seneste bryg · ${ts}`;
  $("drink-name").textContent = DA_DRINK[latest.type] ?? latest.displayName;
  $("drink-floor").textContent = latest.floor;

  const parts = [];
  if (latest.beansG > 0) parts.push(`${latest.beansG.toFixed(1).replace(".", ",")} g kaffe`);
  if (latest.milkMl > 0) parts.push(`${Math.round(latest.milkMl)} ml mælk`);
  if (latest.splashCount === 1) parts.push("+ 1 skvæt");
  else if (latest.splashCount > 1) parts.push(`+ ${latest.splashCount} skvæt`);
  $("composition").innerHTML = parts.length ? parts.join("  ·  ") : "&nbsp;";

  setBigNumber($("brew-co2"), latest.co2G);

  const d = latest.deltaVsCoffee;
  const baseline = latest.co2G - d;
  $("delta").textContent = fmtDeltaPct(d, baseline);
  $("delta").classList.toggle("up", d >= 0);
  $("delta").classList.toggle("down", d < 0);
  $("vs").textContent = `vs. almindelig kaffe (${fmtG(baseline)})`;

  renderPrevious(previous);
}

function renderPrevious(previous) {
  const list = $("previous-list");
  list.innerHTML = "";
  if (previous.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Ingen tidligere bryg endnu";
    list.appendChild(li);
    return;
  }
  for (const b of previous) {
    const name = DA_DRINK[b.type] ?? b.displayName;
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="pb-floor">${escape(b.floor)}</span>` +
      `<span class="pb-time">${escape(fmtBrewTime(b.machineTs))}</span>` +
      `<span class="pb-drink">${escape(name)}</span>` +
      `<span class="pb-co2">${smallNumberHtml(b.co2G)}</span>`;
    list.appendChild(li);
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
