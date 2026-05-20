import type { ProductHistory } from "./types.ts";

export interface EversysClientOpts {
  baseUrl: string;
  token: string;
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
    const r = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.opts.token}` },
    });
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
}
