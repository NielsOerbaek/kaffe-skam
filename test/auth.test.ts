import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
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

  it("refreshOnce posts the rotation body and persists the new pair", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1000 });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      token_type: "Bearer", expires_in: 604800, access_token: "acc-2", refresh_token: "ref-2",
    }), { status: 200 }));
    const tm = new TokenManager({ ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch, now: () => 5000 });
    tm.load();

    await tm.refreshOnce();

    expect(tm.getAccessToken()).toBe("acc-2");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
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

  it("refreshOnce rejects on a malformed 200 response and leaves the stored pair intact", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1000 });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }));
    const tm = new TokenManager({ ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch });
    tm.load();

    await expect(tm.refreshOnce()).rejects.toThrow(/malformed/i);
    expect(tm.getAccessToken()).toBe("acc-1");
    const onDisk = JSON.parse(readFileSync(storePath, "utf8"));
    expect(onDisk.accessToken).toBe("acc-1");
    expect(onDisk.refreshToken).toBe("ref-1");
  });

  it("keeps the refreshed token in memory and logs CRITICAL when persistence fails", async () => {
    seed({ accessToken: "acc-1", refreshToken: "ref-1", expiresAt: 1000 });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      token_type: "Bearer", expires_in: 604800, access_token: "acc-2", refresh_token: "ref-2",
    }), { status: 200 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const tm = new TokenManager({ ...baseOpts(), fetchFn: fetchFn as unknown as typeof fetch, now: () => 0 });
    tm.load();
    chmodSync(dir, 0o500); // make the directory read-only so the atomic write fails
    try {
      await tm.refreshOnce();
      expect(tm.getAccessToken()).toBe("acc-2"); // new token usable in memory
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
      expect(logged).toMatch(/CRITICAL/i);
    } finally {
      chmodSync(dir, 0o700); // restore so afterEach cleanup can remove it
      errSpy.mockRestore();
    }
  });
});
