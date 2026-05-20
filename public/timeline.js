// 30-day timeline bar chart, powered by Chart.js. Editorial styling:
// muted bars in the body fg, today's bar in the up-accent terracotta,
// hairline grid lines, General Sans labels.

const DA_MONTHS = ["jan","feb","mar","apr","maj","jun","jul","aug","sep","okt","nov","dec"];
const state = { days: [], metric: "co2", chart: null };

function fmtG(g) {
  if (g >= 1000) return (g / 1000).toFixed(1).replace(".", ",") + " kg";
  return Math.round(g) + " g";
}
function totalCo2(series)  { return series.reduce((s, d) => s + d.co2_g, 0); }
function totalCups(series) { return series.reduce((s, d) => s + d.cups, 0); }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatDateDa(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return `${d}. ${DA_MONTHS[m - 1] ?? ""} ${y}`;
}
function shortDateDa(yyyymmdd) {
  const [, m, d] = yyyymmdd.split("-").map(Number);
  return `${d}. ${DA_MONTHS[m - 1] ?? ""}`;
}

function render() {
  const days = state.days;
  if (days.length === 0) return;

  const ctx = document.getElementById("chart").getContext("2d");
  const fg = cssVar("--fg") || "#141414";
  const muted = cssVar("--muted") || "rgba(20,20,20,0.66)";
  const hairline = cssVar("--hairline") || "rgba(20,20,20,0.18)";
  const accent = cssVar("--up") || "#8c4a1d";

  const labels = days.map(d => shortDateDa(d.date));
  const values = days.map(d => state.metric === "co2" ? d.co2_g : d.cups);
  const colors = days.map((_, i) => i === days.length - 1 ? accent : "rgba(20, 20, 20, 0.55)");
  const borderColors = days.map((_, i) => i === days.length - 1 ? accent : "rgba(20, 20, 20, 0.55)");

  const isCo2 = state.metric === "co2";
  const yLabel = (v) => isCo2 ? fmtG(v) : Math.round(v).toLocaleString("da-DK");

  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = values;
    state.chart.data.datasets[0].backgroundColor = colors;
    state.chart.data.datasets[0].borderColor = borderColors;
    state.chart.options.scales.y.ticks.callback = yLabel;
    state.chart.update();
  } else {
    state.chart = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: borderColors,
          borderWidth: 0,
          borderRadius: 2,
          borderSkipped: false,
          maxBarThickness: 28,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600, easing: "easeOutCubic" },
        layout: { padding: { top: 10, right: 8, bottom: 0, left: 4 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: fg,
            titleColor: "#f3efe7",
            bodyColor: "#f3efe7",
            titleFont: { family: "General Sans", weight: "500", size: 12 },
            bodyFont:  { family: "General Sans", weight: "300", size: 13 },
            padding: 12,
            displayColors: false,
            cornerRadius: 6,
            callbacks: {
              title: (items) => formatDateDa(days[items[0].dataIndex].date),
              label: (item) => {
                const d = days[item.dataIndex];
                return [
                  `${d.cups.toLocaleString("da-DK")} kopper`,
                  `${fmtG(d.co2_g)} CO₂`,
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
              autoSkip: true,
              maxRotation: 0,
              minRotation: 0,
              callback: (val, idx, ticks) => {
                // Show ~8 labels evenly + the last one
                const step = Math.max(1, Math.round(days.length / 8));
                if (idx % step !== 0 && idx !== days.length - 1) return "";
                return labels[idx];
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

  document.getElementById("page-stats").innerHTML =
    `<span class="stat-line">${totalCups(days).toLocaleString("da-DK")} kopper · ${fmtG(totalCo2(days))} CO₂</span>`;
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
setInterval(load, 60_000);
