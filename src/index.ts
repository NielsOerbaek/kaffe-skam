import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { EversysClient, ApiError, ApiRateLimitError } from "./api.ts";
import { Poller } from "./poller.ts";
import { createServer } from "./server.ts";
import { TokenManager } from "./auth.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const cfg = loadConfig(ROOT);
  mkdirSync(join(ROOT, "data"), { recursive: true });

  const store = new Store(join(ROOT, "data", "kaffe.sqlite"));

  const tokenManager = new TokenManager({
    storePath: join(ROOT, "data", "eversys-tokens.json"),
    authUrl: cfg.authUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    // Local dev against a copy of the box's token: never refresh, or we'd
    // rotate the shared refresh token and lock the box out.
    disableRefresh: process.env.EVERSYS_DISABLE_REFRESH === "1",
  });
  tokenManager.load();   // throws a bootstrap hint if the store is missing
  tokenManager.start();

  const machines = cfg.machines.map(m => ({
    machineId: m.id,
    floor: m.floor,
    client: new EversysClient({
      baseUrl: cfg.api.baseUrl, auth: tokenManager, machineId: m.id,
    }),
  }));
  const poller = new Poller({ machines, store, config: cfg });
  const server = createServer({ store, config: cfg, publicDir: join(ROOT, "public") });
  console.log(`tracking ${machines.length} machine(s): ${machines.map(m => `${m.machineId} (${m.floor})`).join(", ")}`);

  await poller.bootstrap();

  // Refresh the product-name catalog now and every hour. Cheap call,
  // and the names rarely change, but new buttons can be programmed on
  // the machine without restarting us.
  poller.refreshProducts().catch(e => console.warn("initial refreshProducts:", e));
  setInterval(() => {
    poller.refreshProducts().catch(e => console.warn("refreshProducts tick:", e));
  }, 60 * 60 * 1000);

  let backoffIdx = 0;
  const runBrewLoop = async () => {
    try {
      await poller.tickBrews();
      backoffIdx = 0;
    } catch (e: unknown) {
      if (e instanceof ApiRateLimitError || e instanceof ApiError) {
        backoffIdx = Math.min(backoffIdx + 1, cfg.polling.backoffMs.length - 1);
        console.warn(`api error (${e.message}), backing off to ${cfg.polling.backoffMs[backoffIdx]}ms`);
      } else {
        console.error("poller.tickBrews failed:", e);
      }
    }
    const wait = backoffIdx > 0 ? cfg.polling.backoffMs[backoffIdx]! : cfg.polling.brewsIntervalMs;
    setTimeout(runBrewLoop, wait);
  };

  const runCountersLoop = async () => {
    try { await poller.tickCounters(); }
    catch (e) { console.warn("poller.tickCounters failed:", e); }
    setTimeout(runCountersLoop, cfg.polling.countersIntervalMs);
  };

  runBrewLoop();
  runCountersLoop();

  server.listen(cfg.server.port, () => {
    console.log(`kaffe-skam listening on http://0.0.0.0:${cfg.server.port}`);
  });

  process.on("SIGTERM", () => { tokenManager.stop(); server.close(); store.close(); process.exit(0); });
  process.on("SIGINT",  () => { tokenManager.stop(); server.close(); store.close(); process.exit(0); });
}

main().catch(e => {
  console.error("fatal:", e);
  process.exit(1);
});
