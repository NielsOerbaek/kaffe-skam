# Eversys Token Auto-Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the dashboard authenticated to the Eversys API indefinitely by automatically refreshing the OAuth access token before it expires, instead of relying on a hand-pasted token that dies after 7 days.

**Architecture:** A single shared `TokenManager` (new `src/auth.ts`) owns the access+refresh token pair, persists it to `data/eversys-tokens.json`, refreshes proactively on a timer and reactively on a 401, and serializes refresh so the two machine clients can't revoke each other's rotating refresh tokens. `EversysClient` stops holding a frozen token string and instead asks the manager for the current token per request.

**Tech Stack:** TypeScript (ESM, Node ≥20, `tsx`), `vitest`, Node built-in `fetch` and `node:fs`. No new dependencies.

Spec: `docs/superpowers/specs/2026-05-27-eversys-token-refresh-design.md`

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/auth.ts` | `TokenManager` + `StoredTokens` type: load/persist token pair, refresh, proactive timer | **Create** |
| `test/auth.test.ts` | Unit tests for `TokenManager` (fake fetch + injected clock + temp store) | **Create** |
| `src/api.ts` | `EversysClient` takes an `AuthProvider` instead of a token string; 401 → refresh → retry-once | **Modify** |
| `test/api.test.ts` | Update to the `AuthProvider` shape; add 401-retry tests | **Modify** |
| `src/config.ts` | Drop required `EVERSYS_TOKEN`; add `clientId`/`clientSecret`/`authUrl`; remove `Config.token` | **Modify** |
| `test/config.test.ts` | Update fixtures + assertions to the new required vars | **Modify** |
| `src/index.ts` | Construct `TokenManager`, `load()`, `start()`, inject into clients, `stop()` on signal | **Modify** |
| `scripts/backfill.ts` | Read the access token from the store via `TokenManager` instead of `cfg.token` | **Modify** |
| `.env.example` | Document `EVERSYS_CLIENT_ID`/`EVERSYS_CLIENT_SECRET`/`EVERSYS_AUTH_URL`; mark `EVERSYS_TOKEN` legacy | **Modify** |
| `.env` | Add real client ID/secret (gitignored; values from chat, never committed) | **Modify (execution-time)** |
| `data/eversys-tokens.json` | Initial token pair seeded by the one-time bootstrap | **Create (execution-time)** |

`AuthProvider` is defined in `src/api.ts` (where it's consumed). `TokenManager` structurally satisfies it — no import needed in `auth.ts`, keeping `auth.ts` free of any dependency on `api.ts`.

---

## Task 1: `TokenManager` — load, getAccessToken, atomic persist

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenManager } from "../src/auth.ts";

describe("TokenManager", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kaffe-auth-"));
    storePath = join(dir, "eversys-tokens.json");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const baseOpts = () => ({
    storePath,
    authUrl: "https://auth.x/oauth/token",
    clientId: "62",
    clientSecret: "secret",
  });

  const seed = (t: { accessToken: string; refreshToken: string; expiresAt: number }) =>
    writeFileSync(storePath, JSON.stringify(t));

  it("load() throws a bootstrap hint when the store is absent", () => {
    const tm = new TokenManager(baseOpts());
    expect(() => tm.load()).toThrow(/bootstrap/i);
  });

  it("load() reads the stored pair and getAccessToken returns it", () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 999 });
    const tm = new TokenManager(baseOpts());
    tm.load();
    expect(tm.getAccessToken()).toBe("acc-1");
  });

  it("load() throws on a malformed store", () => {
    writeFileSync(storePath, JSON.stringify({ accessToken: "x" }));
    const tm = new TokenManager(baseOpts());
    expect(() => tm.load()).toThrow(/malformed/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/auth.test.ts`
Expected: FAIL — cannot find module `../src/auth.ts`.

- [ ] **Step 3: Create `src/auth.ts` with the minimal load/get/persist code**

```ts
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface TokenManagerOpts {
  storePath: string;
  authUrl: string;
  clientId: string;
  clientSecret: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  refreshMarginMs?: number; // default 24h
  checkIntervalMs?: number; // default 1h
}

interface RefreshResponse {
  token_type: string;
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

export class TokenManager {
  private tokens: StoredTokens | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;
  private readonly checkIntervalMs: number;

  constructor(private readonly opts: TokenManagerOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.refreshMarginMs = opts.refreshMarginMs ?? 24 * 60 * 60 * 1000;
    this.checkIntervalMs = opts.checkIntervalMs ?? 60 * 60 * 1000;
  }

  load(): void {
    if (!existsSync(this.opts.storePath)) {
      throw new Error(
        `No token store at ${this.opts.storePath}. Run the bootstrap ` +
        `(api-token.php generator) to seed the first access+refresh token pair.`,
      );
    }
    const raw = JSON.parse(readFileSync(this.opts.storePath, "utf8"));
    if (
      typeof raw?.accessToken !== "string" ||
      typeof raw?.refreshToken !== "string" ||
      typeof raw?.expiresAt !== "number"
    ) {
      throw new Error(`Token store at ${this.opts.storePath} is malformed. Re-run the bootstrap.`);
    }
    this.tokens = { accessToken: raw.accessToken, refreshToken: raw.refreshToken, expiresAt: raw.expiresAt };
  }

  getAccessToken(): string {
    if (!this.tokens) throw new Error("TokenManager.load() has not been called");
    return this.tokens.accessToken;
  }

  private persist(t: StoredTokens): void {
    const tmp = `${this.opts.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, this.opts.storePath);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat(auth): TokenManager load + getAccessToken + atomic persist"
```

---

## Task 2: `TokenManager.refreshOnce()` — serialized refresh + rotation persist

**Files:**
- Modify: `src/auth.ts`
- Test: `test/auth.test.ts`

- [ ] **Step 1: Add the failing tests**

Append inside the `describe("TokenManager", ...)` block in `test/auth.test.ts`, after the existing tests:

```ts
  it("refreshOnce posts the rotation body and persists the new pair", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1000 });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      token_type: "Bearer", expires_in: 604800, access_token: "acc-2", refresh_token: "ref-2",
    }), { status: 200 }));
    const tm = new TokenManager({ ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch, now: () => 5000 });
    tm.load();

    await tm.refreshOnce();

    expect(tm.getAccessToken()).toBe("acc-2");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://auth.x/oauth/token");
    expect((init as any).method).toBe("POST");
    expect((init as any).headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse((init as any).body)).toEqual({
      grant_type: "refresh_token",
      access_token: "acc-1",
      refresh_token: "ref-1",
      client_id: "62",
      client_secret: "secret",
    });
    const onDisk = JSON.parse(readFileSync(storePath, "utf8"));
    expect(onDisk.accessToken).toBe("acc-2");
    expect(onDisk.refreshToken).toBe("ref-2");
    expect(onDisk.expiresAt).toBe(5000 + 604800 * 1000);
  });

  it("concurrent refreshOnce calls collapse to a single network request", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1000 });
    let resolve!: (r: Response) => void;
    const fetchFn = vi.fn(() => new Promise<Response>((res) => { resolve = res; }));
    const tm = new TokenManager({ ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch, now: () => 0 });
    tm.load();

    const p1 = tm.refreshOnce();
    const p2 = tm.refreshOnce();
    resolve(new Response(JSON.stringify({
      token_type: "Bearer", expires_in: 100, access_token: "acc-2", refresh_token: "ref-2",
    }), { status: 200 }));
    await Promise.all([p1, p2]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refreshOnce rejects on a non-2xx response", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1000 });
    const fetchFn = vi.fn(async () => new Response("nope", { status: 400 }));
    const tm = new TokenManager({ ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch });
    tm.load();
    await expect(tm.refreshOnce()).rejects.toThrow(/refresh failed/i);
  });
```

Add `vi` to the vitest import at the top of the file:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/auth.test.ts`
Expected: FAIL — `tm.refreshOnce is not a function`.

- [ ] **Step 3: Implement `refreshOnce` in `src/auth.ts`**

Add these two methods to the `TokenManager` class (after `persist`):

```ts
  refreshOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    if (!this.tokens) throw new Error("TokenManager.load() has not been called");
    const r = await this.fetchFn(this.opts.authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        access_token: this.tokens.accessToken,
        refresh_token: this.tokens.refreshToken,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    if (!r.ok) throw new Error(`token refresh failed: HTTP ${r.status}`);
    const data = (await r.json()) as RefreshResponse;
    const next: StoredTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: this.now() + data.expires_in * 1000,
    };
    this.tokens = next;
    this.persist(next);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat(auth): serialized refreshOnce with rotation persistence"
```

---

## Task 3: `TokenManager` — proactive `checkAndRefresh` + `start`/`stop`

**Files:**
- Modify: `src/auth.ts`
- Test: `test/auth.test.ts`

- [ ] **Step 1: Add the failing tests**

Append inside the `describe` block in `test/auth.test.ts`:

```ts
  it("checkAndRefresh refreshes when within the margin of expiry", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 10_000 });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      token_type: "Bearer", expires_in: 100, access_token: "acc-2", refresh_token: "ref-2",
    }), { status: 200 }));
    const tm = new TokenManager({
      ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch, now: () => 9_000, refreshMarginMs: 2_000,
    });
    tm.load();

    await tm.checkAndRefresh();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tm.getAccessToken()).toBe("acc-2");
  });

  it("checkAndRefresh does nothing when the token is still fresh", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1_000_000 });
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    const tm = new TokenManager({
      ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch, now: () => 0, refreshMarginMs: 1_000,
    });
    tm.load();

    await tm.checkAndRefresh();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(tm.getAccessToken()).toBe("acc-1");
  });

  it("checkAndRefresh logs a bootstrap hint and does not throw when refresh fails", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 10_000 });
    const fetchFn = vi.fn(async () => new Response("dead", { status: 401 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tm = new TokenManager({
      ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch, now: () => 9_999, refreshMarginMs: 2_000,
    });
    tm.load();

    await expect(tm.checkAndRefresh()).resolves.toBeUndefined();

    const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(logged).toMatch(/bootstrap/i);
    errSpy.mockRestore();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/auth.test.ts`
Expected: FAIL — `tm.checkAndRefresh is not a function`.

- [ ] **Step 3: Implement `checkAndRefresh`, `start`, `stop` in `src/auth.ts`**

Add to the `TokenManager` class:

```ts
  async checkAndRefresh(): Promise<void> {
    if (!this.tokens) return;
    if (this.now() < this.tokens.expiresAt - this.refreshMarginMs) return;
    try {
      await this.refreshOnce();
    } catch (e) {
      console.error(
        `[auth] proactive token refresh failed: ${e instanceof Error ? e.message : String(e)}. ` +
        `If the refresh token has expired, re-run the bootstrap (api-token.php generator).`,
      );
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.checkAndRefresh(); }, this.checkIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/auth.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "feat(auth): proactive checkAndRefresh + start/stop timer"
```

---

## Task 4: `EversysClient` takes an `AuthProvider`; 401 → refresh → retry-once

**Files:**
- Modify: `src/api.ts` (interface at lines 3-8; `req` at lines 36-44)
- Test: `test/api.test.ts`

- [ ] **Step 1: Update `test/api.test.ts` to the new shape and add 401 tests**

Replace the import line (line 5) and add the `AuthProvider` import + a helper. At the top, change:

```ts
import { EversysClient } from "../src/api.ts";
```
to:
```ts
import { EversysClient, type AuthProvider } from "../src/api.ts";

const staticAuth = (token = "tok"): AuthProvider => ({
  getAccessToken: () => token,
  refreshOnce: async () => {},
});
```

In each existing test, replace `token: "tok"` with `auth: staticAuth()`. There are five occurrences (lines 23, 38, 48, 59, 65). For example line 23 becomes:

```ts
    const client = new EversysClient({ baseUrl: "https://api.x", auth: staticAuth(), machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });
```

The auth-header assertion at line 33 stays unchanged (`expect((init as any).headers.Authorization).toBe("Bearer tok");`).

Then add two new tests inside the `describe` block:

```ts
  it("on 401 refreshes once and retries the request", async () => {
    const refreshOnce = vi.fn(async () => {});
    const auth: AuthProvider = { getAccessToken: () => "tok", refreshOnce };
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      return call === 1 ? mkResponse({ error: "expired" }, 401) : mkResponse(countersFixture);
    });
    const client = new EversysClient({ baseUrl: "https://api.x", auth, machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });

    const c = await client.fetchCounters();

    expect(refreshOnce).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(c.beans.totalQuantity).toBeCloseTo(12.345);
  });

  it("throws ApiError(401) when a second 401 follows the refresh", async () => {
    const auth: AuthProvider = { getAccessToken: () => "tok", refreshOnce: vi.fn(async () => {}) };
    const fetchMock = mkFetch(() => mkResponse({ error: "expired" }, 401));
    const client = new EversysClient({ baseUrl: "https://api.x", auth, machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });

    await expect(client.fetchCounters()).rejects.toMatchObject({ name: "ApiError", status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/api.test.ts`
Expected: FAIL — type error / `auth` not a valid option, and the new 401 tests fail.

- [ ] **Step 3: Update `src/api.ts`**

Replace the `EversysClientOpts` interface (lines 3-8) with:

```ts
export interface AuthProvider {
  getAccessToken(): string;
  refreshOnce(): Promise<void>;
}

export interface EversysClientOpts {
  baseUrl: string;
  auth: AuthProvider;
  machineId: number;
  fetchFn?: typeof fetch;
}
```

Replace the `req` method (lines 36-44) with:

```ts
  private async req<T>(path: string): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    const send = () =>
      this.fetchFn(url, { headers: { Authorization: `Bearer ${this.opts.auth.getAccessToken()}` } });
    let r = await send();
    if (r.status === 401) {
      await this.opts.auth.refreshOnce();
      r = await send();
    }
    if (r.status === 429) throw new ApiRateLimitError();
    if (!r.ok) throw new ApiError(`HTTP ${r.status} for ${url}`, r.status);
    return r.json() as Promise<T>;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/api.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/api.ts test/api.test.ts
git commit -m "feat(api): EversysClient uses AuthProvider with 401 refresh-and-retry"
```

---

## Task 5: `config.ts` — client credentials + auth URL, `EVERSYS_TOKEN` optional

**Files:**
- Modify: `src/config.ts` (interface lines 9-29; `loadConfig` lines 88-134)
- Test: `test/config.test.ts`

- [ ] **Step 1: Update `test/config.test.ts`**

Update the env-cleanup in `beforeEach` (lines 11-14) and `afterEach` (lines 16-19) to also clear the new vars. Replace both delete-blocks so each contains:

```ts
    delete process.env.EVERSYS_TOKEN;
    delete process.env.EVERSYS_MACHINES;
    delete process.env.EVERSYS_CLIENT_ID;
    delete process.env.EVERSYS_CLIENT_SECRET;
    delete process.env.EVERSYS_AUTH_URL;
```

Replace `okEnv` (lines 35-38) with:

```ts
  const okEnv = [
    "EVERSYS_CLIENT_ID=cid-abc",
    "EVERSYS_CLIENT_SECRET=csec-abc",
    "EVERSYS_MACHINES=28199:2. sal,19708:3. sal",
  ].join("\n");
```

Replace the test "loads valid config + .env (token + machines)" (lines 40-49) with:

```ts
  it("loads valid config + .env (client creds + machines)", () => {
    writeFiles(minimalConfig, okEnv);
    const c = loadConfig(dir);
    expect(c.co2.beansFactorGPerG).toBe(1.24);
    expect(c.clientId).toBe("cid-abc");
    expect(c.clientSecret).toBe("csec-abc");
    expect(c.authUrl).toBe("https://auth.eversys-telemetry.com/oauth/token");
    expect(c.machines).toEqual([
      { id: 28199, floor: "2. sal" },
      { id: 19708, floor: "3. sal" },
    ]);
  });

  it("EVERSYS_AUTH_URL overrides the default auth URL", () => {
    writeFiles(minimalConfig, okEnv + "\nEVERSYS_AUTH_URL=https://auth.example/token");
    const c = loadConfig(dir);
    expect(c.authUrl).toBe("https://auth.example/token");
  });
```

Replace the test "process.env takes precedence over .env file" (lines 51-56) with:

```ts
  it("process.env takes precedence over .env file", () => {
    writeFiles(minimalConfig, okEnv);
    process.env.EVERSYS_CLIENT_ID = "from-process-env";
    const c = loadConfig(dir);
    expect(c.clientId).toBe("from-process-env");
  });
```

Replace the test "works with only process.env (no .env file present)" (lines 58-65) with:

```ts
  it("works with only process.env (no .env file present)", () => {
    writeFiles(minimalConfig, null);
    process.env.EVERSYS_CLIENT_ID = "cid-process";
    process.env.EVERSYS_CLIENT_SECRET = "csec-process";
    process.env.EVERSYS_MACHINES = "1:Ground floor";
    const c = loadConfig(dir);
    expect(c.clientId).toBe("cid-process");
    expect(c.machines).toEqual([{ id: 1, floor: "Ground floor" }]);
  });
```

Replace the test "throws when EVERSYS_TOKEN is missing" (lines 67-70) with three tests:

```ts
  it("does NOT require EVERSYS_TOKEN", () => {
    writeFiles(minimalConfig, okEnv);
    expect(() => loadConfig(dir)).not.toThrow();
  });

  it("throws when EVERSYS_CLIENT_ID is missing", () => {
    writeFiles(minimalConfig, "EVERSYS_CLIENT_SECRET=csec\nEVERSYS_MACHINES=1:floor\n");
    expect(() => loadConfig(dir)).toThrow(/EVERSYS_CLIENT_ID/);
  });

  it("throws when EVERSYS_CLIENT_SECRET is missing", () => {
    writeFiles(minimalConfig, "EVERSYS_CLIENT_ID=cid\nEVERSYS_MACHINES=1:floor\n");
    expect(() => loadConfig(dir)).toThrow(/EVERSYS_CLIENT_SECRET/);
  });
```

In the remaining tests that still set `EVERSYS_TOKEN=tok` in their env body (the malformed-machines tests at lines 72-85), replace `EVERSYS_TOKEN=tok` with `EVERSYS_CLIENT_ID=cid\nEVERSYS_CLIENT_SECRET=csec`. Specifically:
- "throws when EVERSYS_MACHINES is missing": body becomes `"EVERSYS_CLIENT_ID=cid\nEVERSYS_CLIENT_SECRET=csec\n"`.
- "throws on malformed EVERSYS_MACHINES entry (no colon)": body becomes `"EVERSYS_CLIENT_ID=cid\nEVERSYS_CLIENT_SECRET=csec\nEVERSYS_MACHINES=28199\n"`.
- "throws on non-integer machine id": body becomes `"EVERSYS_CLIENT_ID=cid\nEVERSYS_CLIENT_SECRET=csec\nEVERSYS_MACHINES=abc:floor\n"`.

Replace the test "ignores comments and blank lines in .env" (lines 100-111) with:

```ts
  it("ignores comments and blank lines in .env", () => {
    const body = [
      "# this is a comment",
      "",
      "  # indented comment",
      "EVERSYS_CLIENT_ID=quoted-ok",
      "EVERSYS_CLIENT_SECRET=csec",
      "EVERSYS_MACHINES=1:floor",
    ].join("\n");
    writeFiles(minimalConfig, body);
    const c = loadConfig(dir);
    expect(c.clientId).toBe("quoted-ok");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/config.test.ts`
Expected: FAIL — `c.clientId`/`c.authUrl` undefined and the missing-token test no longer matches.

- [ ] **Step 3: Update `src/config.ts`**

In the `Config` interface, remove the `token: string;` line (line 27) and replace it with:

```ts
  clientId: string;
  clientSecret: string;
  authUrl: string;                               // Eversys OAuth token endpoint
```

In `loadConfig`, replace the token/machines block (lines 93-98) with:

```ts
  const clientId = readVar(env, "EVERSYS_CLIENT_ID");
  if (!clientId) throw new Error(`Missing EVERSYS_CLIENT_ID (set in .env or process environment)`);
  const clientSecret = readVar(env, "EVERSYS_CLIENT_SECRET");
  if (!clientSecret) throw new Error(`Missing EVERSYS_CLIENT_SECRET (set in .env or process environment)`);
  const authUrl = readVar(env, "EVERSYS_AUTH_URL") ?? "https://auth.eversys-telemetry.com/oauth/token";
  const machinesRaw = readVar(env, "EVERSYS_MACHINES");
  if (!machinesRaw) throw new Error(`Missing EVERSYS_MACHINES (set in .env or process environment)`);
  const machines = parseMachines(machinesRaw);
  const locationName = readVar(env, "LOCATION_NAME") ?? "Kaffeskam";
```

In the returned object (lines 123-133), remove `token,` and add `clientId, clientSecret, authUrl,`:

```ts
  return {
    ...raw,
    beansByProduct,
    milkByProduct,
    milkUnitMl,
    zeroMilkProducts,
    productNameOverrides,
    machines,
    clientId,
    clientSecret,
    authUrl,
    locationName,
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): require client credentials + auth URL, drop EVERSYS_TOKEN"
```

---

## Task 6: Wire `TokenManager` into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

No new unit test (this is composition wiring; covered by the end-to-end run in Task 10). Typecheck is the gate.

- [ ] **Step 1: Add the import**

After line 5 (`import { createServer } from "./server.ts";`), add:

```ts
import { TokenManager } from "./auth.ts";
```

- [ ] **Step 2: Construct, load, and start the manager**

Replace the machine-client construction block (lines 16-23) with:

```ts
  const store = new Store(join(ROOT, "data", "kaffe.sqlite"));

  const tokenManager = new TokenManager({
    storePath: join(ROOT, "data", "eversys-tokens.json"),
    authUrl: cfg.authUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
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
```

- [ ] **Step 3: Stop the manager on shutdown**

Replace the signal handlers (lines 68-69) with:

```ts
  process.on("SIGTERM", () => { tokenManager.stop(); server.close(); store.close(); process.exit(0); });
  process.on("SIGINT",  () => { tokenManager.stop(); server.close(); store.close(); process.exit(0); });
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): construct + wire shared TokenManager into clients"
```

---

## Task 7: `scripts/backfill.ts` reads the token from the store

**Files:**
- Modify: `scripts/backfill.ts` (import at line 13-23; `fetchBrewsInRange` signature/use at lines 59-80; call site at line 125; `main` at lines 111-113)

- [ ] **Step 1: Import `TokenManager`**

After line 15 (`import { ApiRateLimitError, ApiError } from "../src/api.ts";`), add:

```ts
import { TokenManager } from "../src/auth.ts";
```

- [ ] **Step 2: Thread a `TokenManager` through `fetchBrewsInRange`**

Change the function signature (lines 59-64) to accept the manager:

```ts
async function fetchBrewsInRange(
  cfg: Config,
  auth: TokenManager,
  machineId: number,
  t1: string,
  t2: string,
): Promise<ProductHistory[]> {
```

Change the fetch call (line 80) from `cfg.token` to the live token:

```ts
      const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.getAccessToken()}` } });
```

- [ ] **Step 3: Construct + load the manager in `main`, and pass it at the call site**

After the `Store` construction (line 113), add:

```ts
  const tokenManager = new TokenManager({
    storePath: join(ROOT, "data", "eversys-tokens.json"),
    authUrl: cfg.authUrl,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
  });
  tokenManager.load();
```

Change the call site (line 125) from:

```ts
    const brews = await fetchBrewsInRange(cfg, m.id, t1, t2);
```
to:
```ts
    const brews = await fetchBrewsInRange(cfg, tokenManager, m.id, t1, t2);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors (confirms no remaining `cfg.token` references anywhere).

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill.ts
git commit -m "feat(backfill): read access token from the store via TokenManager"
```

---

## Task 8: Update `.env.example` and apply real credentials to `.env`

**Files:**
- Modify: `.env.example`
- Modify: `.env` (gitignored — execution-time, real values from chat, NOT committed and NOT written into this plan)

- [ ] **Step 1: Rewrite `.env.example`**

Replace the whole file with:

```
# Copy to .env and fill in real values. .env is gitignored.

# Eversys OAuth client credentials (durable). Request from Eversys
# (techsupport@eversys.com) by registering a REST-API application.
EVERSYS_CLIENT_ID=your-client-id
EVERSYS_CLIENT_SECRET=your-client-secret

# OAuth token endpoint. Optional — defaults to the value below.
# EVERSYS_AUTH_URL=https://auth.eversys-telemetry.com/oauth/token

# LEGACY / UNUSED: the live access token now lives in
# data/eversys-tokens.json, seeded once via the api-token.php generator.
# EVERSYS_TOKEN is no longer read.

# Comma-separated list of "machineId:floorLabel" entries.
# Find each machine's id in the Eversys telemetry dashboard URL.
EVERSYS_MACHINES=28199:2. sal,19708:3. sal

# Brand label rendered in the top-left corner of every page.
LOCATION_NAME=Thoravej 29
```

- [ ] **Step 2: Apply real client credentials to `.env`**

Add (or update) in `.env` — using the real Client ID and Client Secret from the conversation, which must NOT be written into this plan or any committed file:

```
EVERSYS_CLIENT_ID=<client id from chat>
EVERSYS_CLIENT_SECRET=<client secret from chat>
```

Leave the existing `EVERSYS_MACHINES` and `LOCATION_NAME` lines as they are. The old `EVERSYS_TOKEN` line may be left or removed; it is ignored.

- [ ] **Step 3: Commit (`.env.example` only)**

```bash
git add .env.example
git commit -m "docs(env): document client-credential vars, mark EVERSYS_TOKEN legacy"
```

(`.env` is gitignored and is not committed.)

---

## Task 9: Bootstrap — seed `data/eversys-tokens.json` (one-time, browser-driven)

**Files:**
- Create: `data/eversys-tokens.json` (gitignored, execution-time)

This is a one-time operational step using the real account credentials from the conversation. It is performed with the `mcp__claude-in-chrome__*` browser tools. The account password is used only here and is stored nowhere.

- [ ] **Step 1: Drive the generator**

1. Load the chrome tools (`ToolSearch` `select:mcp__claude-in-chrome__tabs_context_mcp,...`).
2. Open a new tab to `https://eversys-telemetry.com/api-token.php`.
3. Enter the **Client-ID** and **Client-Secret** (from chat), submit "Generate Tokens".
4. On the login form, enter the REST-API account **email + password** (from chat), submit.
5. Read the resulting JSON (`get_page_text` / `read_network_requests`): capture `access_token`, `refresh_token`, and `expires_in`.

- [ ] **Step 2: Write the token store**

Compute `expiresAt = Date.now() + expires_in * 1000` and write `data/eversys-tokens.json` with mode `0600`:

```json
{ "accessToken": "<access_token>", "refreshToken": "<refresh_token>", "expiresAt": <epoch-ms> }
```

Use a small Node one-liner so the values never touch the shell history verbatim (substitute the captured values):

```bash
node -e 'const fs=require("fs");fs.writeFileSync("data/eversys-tokens.json",JSON.stringify({accessToken:process.env.A,refreshToken:process.env.R,expiresAt:Date.now()+Number(process.env.E)*1000}),{mode:0o600})'
```
(with `A`, `R`, `E` set in the environment of that single command).

- [ ] **Step 3: Verify the store loads**

Run: `node --import tsx/esm -e 'import("./src/auth.ts").then(async ({TokenManager})=>{const tm=new TokenManager({storePath:"data/eversys-tokens.json",authUrl:"x",clientId:"x",clientSecret:"x"});tm.load();console.log("loaded, token length:",tm.getAccessToken().length)})'`
Expected: prints a non-zero token length (no throw).

No commit (the file is gitignored).

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites green (auth, api, config, plus the untouched beans/co2/merge/poller/server/store suites).

- [ ] **Step 2: Live run — confirm authentication works against the real API**

Run: `npm run dev`
Expected logs: `tracking N machine(s): ...` then `kaffe-skam listening on http://0.0.0.0:8080`, and the brew/counter loops run **without** repeated `api error (HTTP 401 ...)` backoff messages. Open `http://localhost:8080/` and confirm live data renders. Stop with Ctrl-C.

- [ ] **Step 3: Force a proactive refresh and confirm rotation**

Temporarily prove the refresh path end-to-end against the real auth server:
1. Note the current `refreshToken` in `data/eversys-tokens.json`.
2. Run a one-shot refresh:
   ```bash
   node --import tsx/esm -e 'import("./src/auth.ts").then(async ({TokenManager})=>{const {loadConfig}=await import("./src/config.ts");const c=loadConfig(process.cwd());const tm=new TokenManager({storePath:"data/eversys-tokens.json",authUrl:c.authUrl,clientId:c.clientId,clientSecret:c.clientSecret});tm.load();await tm.refreshOnce();console.log("refreshed OK");})'
   ```
   Expected: prints `refreshed OK`, and `data/eversys-tokens.json` now holds a **different** `accessToken`/`refreshToken` and a fresh `expiresAt` ~7 days out.
3. Re-run `npm run dev` briefly to confirm the new token still authenticates.

- [ ] **Step 4: Final commit (if any tracked files changed during verification)**

Only `docs/`/`src/`/`test/` changes are committable; `data/` and `.env` stay uncommitted. If nothing tracked changed, skip.

---

## Self-Review Notes

- **Spec coverage:** TokenManager (T1-3), persistence/atomic write (T1), serialized refresh + rotation (T2), proactive timer + margin + failure logging (T3), client `AuthProvider` + 401 retry-once (T4), config changes incl. `EVERSYS_TOKEN` optional (T5), index wiring + stop on signal (T6), backfill (T7), `.env`/`.env.example` (T8), browser bootstrap (T9), tests + live run + forced-refresh verification (T10). All spec sections map to a task.
- **Type consistency:** `AuthProvider { getAccessToken(): string; refreshOnce(): Promise<void> }` is defined in T4 and consumed identically in T6/T7; `TokenManager` exposes exactly those two methods (T1-2) so it satisfies the interface structurally. `StoredTokens` fields (`accessToken`/`refreshToken`/`expiresAt`) are consistent across auth.ts, the store file, and the bootstrap.
- **Secrets:** real client ID/secret and the account password appear only in execution-time steps (T8 Step 2, T9) as `<from chat>` placeholders — never in committed files or this plan.
