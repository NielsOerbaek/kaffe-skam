import type { ProductHistory } from "./types.ts";

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

export interface CountersResponse {
  machineId: number;
  machineTimestamp: string;
  serverTimestamp: string;
  lastReset: string;
  beans: { totalQuantity: number };
  water: { totalQuantity: number };
}

export class ApiError extends Error {
  override readonly name: string = "ApiError";
  constructor(message: string, public readonly status: number) { super(message); }
}

export class ApiRateLimitError extends ApiError {
  override readonly name = "ApiRateLimitError";
  constructor() { super("rate limited", 429); }
}

export class EversysClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: EversysClientOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

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

  fetchBrewsAfter(afterId: number | null, limit: number): Promise<ProductHistory[]> {
    if (afterId == null) {
      const qs = new URLSearchParams({ sortOrder: "DESC", limit: String(limit) });
      return this.req(`/v3/machines/${this.opts.machineId}/products?${qs}`);
    }
    const qs = new URLSearchParams({ afterId: String(afterId), sortOrder: "ASC", limit: String(limit) });
    return this.req(`/v3/machines/${this.opts.machineId}/products?${qs}`);
  }

  fetchCounters(): Promise<CountersResponse> {
    return this.req(`/v3/machines/machine-counters/${this.opts.machineId}`);
  }

  // Returns the list of products configured on the machine. Empty-name
  // entries are filtered out — only the actual programmed buttons.
  async fetchProducts(side: "LEFT" | "RIGHT" = "LEFT"): Promise<Array<{ productId: number; name: string }>> {
    let raw: any[];
    try {
      raw = await this.req<any[]>(`/v3/machines/${this.opts.machineId}/product-parameters/${side}`);
    } catch (e) {
      // Some machines only have one side; treat a 404 as "no products on this side".
      if (e instanceof ApiError && e.status === 404) return [];
      throw e;
    }
    const out: Array<{ productId: number; name: string }> = [];
    for (const p of raw ?? []) {
      const name = (p?.displaySettings?.name ?? p?.generalSettings?.name ?? "").trim();
      if (!name) continue;
      if (typeof p.productId !== "number") continue;
      out.push({ productId: p.productId, name });
    }
    return out;
  }
}
