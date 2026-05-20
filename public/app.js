const $ = (id) => document.getElementById(id);
const REFRESH_MS = 3000;

// Fallback Danish labels for the API's drink-type enum, used only when the
// machine's product-parameters lookup hasn't resolved a real button name.
const DA_DRINK_FALLBACK = {
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
// Prefer the resolved machine-button name, fall back to the Danish enum label.
function brewDisplayName(brew) {
  return brew.productName ?? DA_DRINK_FALLBACK[brew.type] ?? brew.displayName;
}

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
function fmtClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}.${p(d.getMinutes())}`;
}

// "Today's CO₂ is the same as …" — a small library of relatable equivalents
// that rotate every ~6 s. Functions return a Danish phrase, given grams of CO₂.
function fmtDa(n, decimals = 0) {
  return n.toLocaleString("da-DK", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}
const EQUIVALENCES = [
  // ~200 g CO₂ per km in an average car
  (g) => {
    if (g <= 0) return "";
    const km = g / 200;
    if (km < 0.1) return "≈ et par meter i bil";
    return `≈ ${fmtDa(km, km < 10 ? 1 : 0)} km i bil`;
  },
  // ~80 g CO₂ per banana shipped from Costa Rica
  (g) => {
    if (g <= 0) return "";
    const n = Math.max(1, Math.round(g / 80));
    return `≈ ${fmtDa(n)} ${n === 1 ? "banan" : "bananer"} fra Costa Rica`;
  },
  // ~50 g CO₂ per minute in a hot shower (gas-heated)
  (g) => {
    if (g <= 0) return "";
    const m = Math.max(1, Math.round(g / 50));
    return `≈ ${fmtDa(m)} ${m === 1 ? "minut" : "minutter"} varmt bad`;
  },
  // ~10 g CO₂ per full iPhone charge (Danish grid intensity ~ 100 g/kWh × ~15 Wh battery)
  (g) => {
    if (g <= 0) return "";
    const n = Math.max(1, Math.round(g / 10));
    return `≈ ${fmtDa(n)} ${n === 1 ? "opladning" : "opladninger"} af en iPhone`;
  },
  // ~150 g CO₂ per kg apples shipped from New Zealand
  (g) => {
    if (g <= 0) return "";
    const kg = g / 150;
    if (kg < 0.5) return "";
    return `≈ ${fmtDa(kg, kg < 10 ? 1 : 0)} kg æbler fra New Zealand`;
  },
];
const DA_MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const DA_MONTHS_FULL = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
function fmtBrewTs(machineTs) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):/.exec(machineTs);
  if (!m) return machineTs;
  const month = DA_MONTHS[parseInt(m[2], 10) - 1] ?? m[2];
  return `${parseInt(m[3], 10)}. ${month} kl. ${m[4]}.${m[5]}`;
}
function fmtMonthHeader(now = new Date()) {
  const m = DA_MONTHS_FULL[now.getMonth()] ?? "";
  return `${m.charAt(0).toUpperCase() + m.slice(1)} ${now.getFullYear()}`;
}

// Danish relative time. machineTs is local-time ISO without "Z" — Date()
// parses it as local time, which is what we want.
function fmtRelativeTimeDa(machineTs) {
  const ts = new Date(machineTs).getTime();
  if (!Number.isFinite(ts)) return "";
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "lige nu";
  if (s < 60) return `${s} sekunder siden`;
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "1 minut siden" : `${m} minutter siden`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 time siden" : `${h} timer siden`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 dag siden" : `${d} dage siden`;
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
  // Brand label comes from the server now (env-driven)
  if (s.locationName) $("brand").textContent = s.locationName;

  // Left top — today's CO₂ as the hero; cups count as the supporting line
  setBigNumber($("today-co2"), s.today.co2_g);
  $("today-cups-line").textContent = `${s.today.cups.toLocaleString("da-DK")} ${s.today.cups === 1 ? "kop" : "kopper"} i dag`;
  // Stash today's CO₂ so the equivalence ticker can re-render between fetches
  todayCo2g = s.today.co2_g;
  updateEquivalence();

  // Left bottom — "<Month> <Year>" header + month-to-date stats
  $("month-header").textContent = fmtMonthHeader();
  $("month-cups").textContent = s.month.cups.toLocaleString("da-DK");
  $("month-co2").textContent = fmtG(s.month.co2_g);

  $("chip-time").textContent = fmtClock();
  $("stale-badge").hidden = !s.stale;

  const brews = s.lastBrews ?? [];
  const latest = brews[0];
  const previous = brews.slice(1);

  if (!latest) {
    latestBrewTs = null;
    $("last-label").textContent = "Seneste bryg";
    $("drink-name").textContent = "Venter på første kop…";
    $("composition").innerHTML = " ";
    $("brew-co2").textContent = "—";
    $("delta").textContent = "";
    $("vs").textContent = "";
    renderPrevious([]);
    return;
  }

  latestBrewTs = latest.machineTs;
  updateLastLabel();
  $("drink-name").textContent = brewDisplayName(latest);
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
  $("vs").textContent = `vs. sort kaffe (${fmtG(baseline)})`;

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
    const name = brewDisplayName(b);
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="pb-floor">${escape(b.floor)}</span>` +
      `<span class="pb-time">${escape(fmtBrewTime(b.machineTs))}</span>` +
      `<span class="pb-drink">${escape(name)}</span>` +
      `<span class="pb-co2">${smallNumberHtml(b.co2G)}</span>`;
    list.appendChild(li);
  }
}

// Latest brew's machine timestamp, tracked outside render() so a separate
// 10s tick can keep the relative time fresh between fetches.
let latestBrewTs = null;
function updateLastLabel() {
  if (!latestBrewTs) return;
  const abs = fmtBrewTs(latestBrewTs);
  const rel = fmtRelativeTimeDa(latestBrewTs);
  $("last-label").textContent = rel ? `Seneste bryg · ${abs} · ${rel}` : `Seneste bryg · ${abs}`;
}

// Cross-fading equivalence ticker
let todayCo2g = 0;
let equivIdx = 0;
function updateEquivalence() {
  const el = $("today-equiv");
  if (!el) return;
  // Pick the next non-empty equivalent so we don't show a blank during cycles
  let text = "";
  for (let i = 0; i < EQUIVALENCES.length; i++) {
    const fn = EQUIVALENCES[(equivIdx + i) % EQUIVALENCES.length];
    text = fn(todayCo2g);
    if (text) { equivIdx = (equivIdx + i + 1) % EQUIVALENCES.length; break; }
  }
  el.classList.add("fading");
  setTimeout(() => {
    el.textContent = text || " ";
    el.classList.remove("fading");
  }, 600);
}

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(updateLastLabel, 10_000);
setInterval(updateEquivalence, 10_000);
