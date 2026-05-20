// Shared chrome script — wires up the LIVE chip and the clock used on
// every page (timeline, drinks, metode). The Live dashboard handles its
// own LIVE state in app.js since it polls /api/state already.

(function () {
  const elStatus = document.getElementById("chip-status");
  const elTime = document.getElementById("chip-time");
  if (!elStatus || !elTime) return;

  function fmtClock(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}.${p(d.getMinutes())}`;
  }

  async function checkLive() {
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      const s = await r.json();
      elStatus.textContent = s.stale ? "Forældet" : "Live";
    } catch {
      elStatus.textContent = "Offline";
    }
    elTime.textContent = fmtClock();
  }

  checkLive();
  setInterval(checkLive, 30_000);
})();
