const $ = (id) => document.getElementById(id);
const REFRESH_MS = 3000;

function fmtG(g) {
  if (g == null) return "—";
  if (g >= 1000) return (g / 1000).toFixed(2) + " kg";
  return Math.round(g) + " g";
}
function fmtDriveKm(co2_g) {
  const km = co2_g / 200;
  if (!co2_g) return " ";
  return km >= 0.1 ? `≈ ${km.toFixed(1)} km by car` : "≈ a few metres by car";
}
function fmtClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function refresh() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error("status " + r.status);
    const s = await r.json();
    render(s);
    $("chip-status").textContent = s.stale ? "Stale" : "Live";
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
    $("last-label").textContent = "Last brew";
    $("drink-name").textContent = "Awaiting first cup…";
    $("composition").innerHTML = " ";
    $("delta").textContent = "—";
    $("vs").textContent = "";
    $("coffee-bar").style.width = "0%";
    $("brew-bar").style.width = "0%";
    $("coffee-v").textContent = "—";
    $("brew-v").textContent = "—";
    return;
  }

  const b = s.lastBrew;
  const ts = b.machineTs.replace("T", " ").slice(0, 16);
  $("last-label").textContent = "Last brew · " + ts;
  $("drink-name").textContent = b.displayName;
  const parts = [`${b.beansG.toFixed(1)} g beans`];
  if (b.milkMl > 0) parts.push(`${Math.round(b.milkMl)} ml milk`);
  if (b.splashCount > 0) parts.push(`+ ${b.splashCount} splash`);
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

  $("vs").textContent = `vs. plain coffee (${fmtG(baseline)})`;
}

refresh();
setInterval(refresh, REFRESH_MS);
