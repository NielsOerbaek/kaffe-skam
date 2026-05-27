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
