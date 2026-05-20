import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EversysClient } from "../src/api.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const productsFixture = JSON.parse(readFileSync(join(__dirname, "fixtures/products-page.json"), "utf8"));
const countersFixture = JSON.parse(readFileSync(join(__dirname, "fixtures/counters.json"), "utf8"));

const mkResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type FetchArgs = [URL | RequestInfo, RequestInit?];
const mkFetch = (resp: () => Response) =>
  vi.fn<FetchArgs, Promise<Response>>(async () => resp());

describe("EversysClient", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("fetchBrewsAfter calls correct URL + auth header", async () => {
    const fetchMock = mkFetch(() => mkResponse(productsFixture));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });
    const r = await client.fetchBrewsAfter(1000, 100);
    expect(r).toHaveLength(3);
    const first = r[0];
    expect(first?.id).toBe(1001);

    const call0 = fetchMock.mock.calls[0];
    expect(call0).toBeDefined();
    const [url, init] = call0!;
    expect(url).toBe("https://api.x/v3/machines/123/products?afterId=1000&sortOrder=ASC&limit=100");
    expect((init as any).headers.Authorization).toBe("Bearer tok");
  });

  it("fetchBrewsAfter without afterId omits the query param", async () => {
    const fetchMock = mkFetch(() => mkResponse([]));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });
    await client.fetchBrewsAfter(null, 1);
    const call0 = fetchMock.mock.calls[0];
    expect(call0).toBeDefined();
    const [url] = call0!;
    expect(url).toBe("https://api.x/v3/machines/123/products?sortOrder=DESC&limit=1");
  });

  it("fetchCounters returns parsed counter model", async () => {
    const fetchMock = mkFetch(() => mkResponse(countersFixture));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });
    const c = await client.fetchCounters();
    expect(c.beans.totalQuantity).toBeCloseTo(12.345);
    const call0 = fetchMock.mock.calls[0];
    expect(call0).toBeDefined();
    const [url] = call0!;
    expect(url).toBe("https://api.x/v3/machines/machine-counters/123");
  });

  it("throws ApiRateLimitError on 429", async () => {
    const fetchMock = mkFetch(() => mkResponse({ error: "x" }, 429));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });
    await expect(client.fetchBrewsAfter(0, 1)).rejects.toMatchObject({ name: "ApiRateLimitError" });
  });

  it("throws ApiError on non-2xx (not 429)", async () => {
    const fetchMock = mkFetch(() => mkResponse({ error: "x" }, 500));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock as unknown as typeof fetch });
    await expect(client.fetchBrewsAfter(0, 1)).rejects.toMatchObject({ name: "ApiError", status: 500 });
  });
});
