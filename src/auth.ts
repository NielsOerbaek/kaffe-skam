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
  // Local-dev escape hatch: when true, the manager never hits the auth server.
  // The refresh token rotates on every refresh and the box is its sole owner,
  // so a second live instance must NOT refresh or it revokes the box's token.
  disableRefresh?: boolean;
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
  private readonly disableRefresh: boolean;

  constructor(private readonly opts: TokenManagerOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.refreshMarginMs = opts.refreshMarginMs ?? 24 * 60 * 60 * 1000;
    this.checkIntervalMs = opts.checkIntervalMs ?? 60 * 60 * 1000;
    this.disableRefresh = opts.disableRefresh ?? false;
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

  refreshOnce(): Promise<void> {
    if (this.disableRefresh) {
      return Promise.reject(new Error(
        "token refresh disabled (local no-refresh mode); not rotating the box's token",
      ));
    }
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
    const data = (await r.json()) as Partial<RefreshResponse>;
    if (
      typeof data.access_token !== "string" ||
      typeof data.refresh_token !== "string" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in)
    ) {
      throw new Error("token refresh returned a malformed response");
    }
    const next: StoredTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: this.now() + data.expires_in * 1000,
    };
    // The server has now rotated the refresh token: the old one is dead and
    // `next` is the only valid pair. Update memory first so the live process
    // keeps working, then persist. If persistence fails the token survives only
    // in memory — log loudly and distinctly, because a restart would read the
    // stale, now-dead pair from disk and silently break the refresh chain.
    this.tokens = next;
    try {
      this.persist(next);
    } catch (e) {
      console.error(
        `[auth] CRITICAL: token refreshed but could NOT be persisted to ${this.opts.storePath}: ` +
        `${e instanceof Error ? e.message : String(e)}. The new token works until the next restart, ` +
        `after which you must re-run the bootstrap (api-token.php generator).`,
      );
    }
  }

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
    if (this.disableRefresh) {
      console.warn("[auth] no-refresh mode: proactive refresh disabled; token valid only until expiry");
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => { void this.checkAndRefresh(); }, this.checkIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
