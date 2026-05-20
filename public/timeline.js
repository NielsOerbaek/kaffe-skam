// Renders the 30-day timeline as a refined editorial bar chart.
// X = day (oldest → today), Y = CO₂eq OR cups (toggle).

const SVG_NS = "http://www.w3.org/2000/svg";
const DA_MONTHS = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];

const state = { days: [], metric: "co2" };

function fmtG(g) {
  if (g >= 1000) return (g / 1000).toFixed(1).replace(".", ",") + " kg";
  return Math.round(g) + " g";
}

function totalCo2(series) { return series.reduce((s, d) => s + d.co2_g, 0); }
function totalCups(series) { return series.reduce((s, d) => s + d.cups, 0); }

function render() {
  const svg = document.getElementById("chart");
  const xAxis = document.getElementById("x-axis");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  xAxis.innerHTML = "";

  const days = state.days;
  if (days.length === 0) return;

  const VB_W = 1000, VB_H = 360;
  const padTop = 30, padBottom = 30, padX = 0;
  const innerW = VB_W - padX * 2;
  const innerH = VB_H - padTop - padBottom;

  const values = days.map(d => state.metric === "co2" ? d.co2_g : d.cups);
  const maxVal = Math.max(1, ...values);
  const niceMax = niceUpperBound(maxVal);
  const slotW = innerW / days.length;
  const barW = slotW * 0.55;

  // Reference grid lines at 0, 25, 50, 75, 100% of niceMax
  for (let i = 0; i <= 4; i++) {
    const y = padTop + innerH * (1 - i / 4);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(padX));
    line.setAttribute("x2", String(VB_W - padX));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", i === 0 ? "axis" : "grid");
    svg.appendChild(line);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", "6");
    label.setAttribute("y", String(y - 4));
    label.setAttribute("class", "y-label");
    const val = (niceMax * i / 4);
    label.textContent = state.metric === "co2"
      ? (val === 0 ? "" : fmtG(val))
      : (val === 0 ? "" : Math.round(val).toString());
    svg.appendChild(label);
  }

  // Today is the last index; highlight it
  const lastIdx = days.length - 1;

  days.forEach((d, i) => {
    const v = state.metric === "co2" ? d.co2_g : d.cups;
    const h = (v / niceMax) * innerH;
    const x = padX + slotW * i + (slotW - barW) / 2;
    const y = padTop + innerH - h;

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(barW));
    rect.setAttribute("height", String(Math.max(h, 0)));
    rect.setAttribute("class", i === lastIdx ? "bar today" : "bar");
    rect.setAttribute("rx", "1");
    const tooltip = document.createElementNS(SVG_NS, "title");
    tooltip.textContent = `${formatDateDa(d.date)}: ${d.cups} kopper · ${fmtG(d.co2_g)} CO₂`;
    rect.appendChild(tooltip);
    svg.appendChild(rect);
  });

  // X-axis labels: show every ~5th day to avoid crowding
  const step = Math.max(1, Math.round(days.length / 8));
  days.forEach((d, i) => {
    if (i % step !== 0 && i !== days.length - 1) return;
    const tick = document.createElement("span");
    tick.className = "x-tick";
    const dt = new Date(d.date + "T00:00:00");
    tick.textContent = `${dt.getDate()}. ${DA_MONTHS[dt.getMonth()] ?? ""}`;
    tick.style.left = `${(padX + slotW * (i + 0.5)) / VB_W * 100}%`;
    xAxis.appendChild(tick);
  });

  // Update header stats
  document.getElementById("page-stats").innerHTML =
    `<span class="stat-line">${totalCups(days).toLocaleString("da-DK")} kopper · ${fmtG(totalCo2(days))} CO₂</span>`;
}

function niceUpperBound(v) {
  if (v <= 0) return 1;
  const pow10 = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / pow10;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * pow10;
}

function formatDateDa(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return `${d}. ${DA_MONTHS[m - 1] ?? ""} ${y}`;
}

async function load() {
  const r = await fetch("/api/timeline?days=30", { cache: "no-store" });
  const j = await r.json();
  state.days = j.series;
  render();
}

document.getElementById("chart-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-metric]");
  if (!btn) return;
  state.metric = btn.dataset.metric;
  document.querySelectorAll("#chart-toggle button").forEach(b => {
    b.classList.toggle("active", b === btn);
  });
  render();
});

load();
window.addEventListener("resize", render);
setInterval(load, 60_000);
