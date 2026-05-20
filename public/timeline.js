// 52-week timeline bar chart, powered by Chart.js. Each bar is one ISO
// week (Monday-starting). Today's week is highlighted in the up-accent
// terracotta. Editorial styling matches the rest of the app.

const DA_MONTHS = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];
const state = { weeks: [], avgWeek: null, avgDay: null, metric: "co2", chart: null };

function fmtG(g) {
  if (g >= 1000) return (g / 1000).toFixed(1).replace(".", ",") + " kg";
  return Math.round(g) + " g";
}
function totalCo2(series)  { return series.reduce((s, d) => s + d.co2_g, 0); }
function totalCups(series) { return series.reduce((s, d) => s + d.cups, 0); }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function parseDate(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return new Date(y, (m - 1), d);
}
function addDays(dt, n) {
  const out = new Date(dt);
  out.setDate(out.getDate() + n);
  return out;
}
function fmtDayMonth(dt) {
  return `${dt.getDate()}. ${DA_MONTHS[dt.getMonth()] ?? ""}`;
}
function isoWeekNumber(dt) {
  // ISO week: week containing the year's first Thursday is week 1
  const d = new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}
function weekLabel(weekStart) {
  // "Uge N" if not first week of month; otherwise short month label "1. maj"
  const dt = parseDate(weekStart);
  const isFirstWeekOfMonth = dt.getDate() <= 7;
  return isFirstWeekOfMonth ? `${dt.getDate()}. ${DA_MONTHS[dt.getMonth()]}` : `u${isoWeekNumber(dt)}`;
}

function render() {
  const weeks = state.weeks;
  if (weeks.length === 0) return;

  const ctx = document.getElementById("chart").getContext("2d");
  const fg = cssVar("--fg") || "#141414";
  const muted = cssVar("--muted") || "rgba(20,20,20,0.66)";
  const hairline = cssVar("--hairline") || "rgba(20,20,20,0.18)";
  const accent = cssVar("--up") || "#8c4a1d";

  const labels = weeks.map(w => weekLabel(w.weekStart));
  const values = weeks.map(w => state.metric === "co2" ? w.co2_g : w.cups);
  const lastIdx = weeks.length - 1;

  // Today's week gets a visible accent dot; the rest stays invisible until hover.
  const pointRadii   = weeks.map((_, i) => i === lastIdx ? 5 : 0);
  const pointFill    = weeks.map((_, i) => i === lastIdx ? accent : "transparent");
  const pointStroke  = weeks.map((_, i) => i === lastIdx ? accent : "transparent");

  const isCo2 = state.metric === "co2";
  const yLabel = (v) => isCo2 ? fmtG(v) : Math.round(v).toLocaleString("da-DK");

  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = values;
    state.chart.data.datasets[0].pointBackgroundColor = pointFill;
    state.chart.data.datasets[0].pointBorderColor = pointStroke;
    state.chart.data.datasets[0].pointRadius = pointRadii;
    state.chart.options.scales.y.ticks.callback = yLabel;
    // Update the dashed reference line too (it's the second dataset)
    const avgValue = state.metric === "co2" ? state.avgWeek?.co2_g : state.avgWeek?.cups;
    if (state.chart.data.datasets[1]) {
      state.chart.data.datasets[1].data = labels.map(() => avgValue ?? null);
    }
    state.chart.update();
  } else {
    const avgValue = state.metric === "co2" ? state.avgWeek?.co2_g : state.avgWeek?.cups;
    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: values,
            borderColor: fg,
            backgroundColor: "rgba(20, 20, 20, 0.06)",
            borderWidth: 1.6,
            tension: 0.35,
            cubicInterpolationMode: "monotone",
            fill: true,
            pointBackgroundColor: pointFill,
            pointBorderColor: pointStroke,
            pointRadius: pointRadii,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: fg,
            pointHoverBorderColor: fg,
            pointHoverBorderWidth: 0,
          },
          {
            // Horizontal reference line at the average WEEKLY value
            label: "Gennemsnit",
            data: labels.map(() => avgValue ?? null),
            borderColor: muted,
            borderDash: [4, 4],
            borderWidth: 1,
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600, easing: "easeOutCubic" },
        layout: { padding: { top: 10, right: 8, bottom: 0, left: 4 } },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            backgroundColor: fg,
            titleColor: "#f3efe7",
            bodyColor: "#f3efe7",
            titleFont: { family: "General Sans", weight: "500", size: 12 },
            bodyFont:  { family: "General Sans", weight: "300", size: 13 },
            padding: 12,
            displayColors: false,
            cornerRadius: 6,
            callbacks: {
              title: (items) => {
                const w = weeks[items[0].dataIndex];
                const start = parseDate(w.weekStart);
                const end = addDays(start, 6);
                return `Uge ${isoWeekNumber(start)} · ${fmtDayMonth(start)} – ${fmtDayMonth(end)}`;
              },
              label: (item) => {
                const w = weeks[item.dataIndex];
                return [
                  `${w.cups.toLocaleString("da-DK")} kopper`,
                  `${fmtG(w.co2_g)} CO₂`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false, drawBorder: false },
            border: { display: false },
            ticks: {
              color: muted,
              font: { family: "General Sans", size: 11, weight: "400" },
              autoSkip: false,
              maxRotation: 0,
              minRotation: 0,
              callback: (val, idx) => {
                // Label only weeks whose Monday falls within the first 7 days
                // of a month — gives roughly one label per month.
                const w = weeks[idx];
                if (!w) return "";
                const dt = parseDate(w.weekStart);
                if (dt.getDate() <= 7) return `${DA_MONTHS[dt.getMonth()]}`.toUpperCase();
                return "";
              },
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: hairline, drawBorder: false, lineWidth: 1 },
            border: { display: false },
            ticks: {
              color: muted,
              font: { family: "General Sans", size: 11, weight: "400" },
              callback: yLabel,
              maxTicksLimit: 5,
              padding: 8,
            },
          },
        },
      },
    });
  }

  const tot = `${totalCups(weeks).toLocaleString("da-DK")} kopper · ${fmtG(totalCo2(weeks))} CO₂`;
  const avg = state.avgDay
    ? `Den gennemsnitlige dag: ${Math.round(state.avgDay.cups).toLocaleString("da-DK")} kopper · ${fmtG(state.avgDay.co2_g)} CO₂`
    : "";
  document.getElementById("page-stats").innerHTML =
    `<span class="stat-line">${tot}</span>` +
    (avg ? `<span class="stat-line avg-stat">${avg}</span>` : "");
}

async function load() {
  const r = await fetch("/api/timeline?weeks=52", { cache: "no-store" });
  const j = await r.json();
  state.weeks = j.series;
  state.avgWeek = j.averagePerWeek ?? null;
  state.avgDay  = j.averagePerDay  ?? null;
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
setInterval(load, 60_000);
