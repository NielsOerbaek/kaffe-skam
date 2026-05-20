// Per-drink-type breakdown for the current month.
// Ranked by CO₂ contribution. Bar shows share of total CO₂. Cup count and
// total CO₂ are spelled out next to the bar.

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
const DA_MONTHS_FULL = ["januar","februar","marts","april","maj","juni","juli","august","september","oktober","november","december"];

function fmtG(g) {
  if (g >= 1000) return (g / 1000).toFixed(1).replace(".", ",") + " kg";
  return Math.round(g) + " g";
}

function escape(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function load() {
  const r = await fetch("/api/drinks", { cache: "no-store" });
  const j = await r.json();
  render(j);
}

function render(j) {
  const [y, m] = j.month.split("-").map(Number);
  const monthName = DA_MONTHS_FULL[m - 1] ?? "";
  document.getElementById("drinks-month").textContent = `${monthName.charAt(0).toUpperCase() + monthName.slice(1)} ${y}`;
  document.getElementById("drinks-stats").textContent =
    `${j.total.cups.toLocaleString("da-DK")} kopper · ${fmtG(j.total.co2_g)} CO₂eq i alt`;

  const list = document.getElementById("drink-list");
  list.innerHTML = "";
  if (j.drinks.length === 0) {
    list.innerHTML = `<li class="empty">Ingen bryg endnu denne måned.</li>`;
    return;
  }
  for (const d of j.drinks) {
    const name = DA_DRINK[d.type] ?? d.displayName;
    const pct = Math.round(d.shareOfCo2 * 100);
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="dl-drink">${escape(name)}</span>` +
      `<span class="dl-bar"><span class="dl-bar-fill" style="width:${d.shareOfCo2 * 100}%"></span></span>` +
      `<span class="dl-share">${pct} %</span>` +
      `<span class="dl-cups">${d.cups.toLocaleString("da-DK")}</span>` +
      `<span class="dl-co2">${escape(fmtG(d.co2_g))}<span class="unit-tail">&nbsp;CO₂</span></span>`;
    list.appendChild(li);
  }
}

load();
setInterval(load, 60_000);
