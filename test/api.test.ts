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

describe("EversysClient", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("fetchBrewsAfter calls correct URL + auth header", async () => {
    const fetchMock = vi.fn(async () => mkResponse(productsFixture));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    const r = await client.fetchBrewsAfter(1000, 100);
    expect(r).toHaveLength(3);
    expect(r[0].id).toBe(1001);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v3/machines/123/products?afterId=1000&sortOrder=ASC&limit=100");
    expect((init as any).headers.Authorization).toBe("Bearer tok");
  });

  it("fetchBrewsAfter without afterId omits the query param", async () => {
    const fetchMock = vi.fn(async () => mkResponse([]));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    await client.fetchBrewsAfter(null, 1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v3/machines/123/products?sortOrder=DESC&limit=1");
  });

  it("fetchCounters returns parsed counter model", async () => {
    const fetchMock = vi.fn(async () => mkResponse(countersFixture));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    const c = await client.fetchCounters();
    expect(c.beans.totalQuantity).toBeCloseTo(12.345);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v3/machines/machine-counters/123");
  });

  it("throws ApiRateLimitError on 429", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ error: "x" }, 429));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    await expect(client.fetchBrewsAfter(0, 1)).rejects.toMatchObject({ name: "ApiRateLimitError" });
  });

  it("throws ApiError on non-2xx (not 429)", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ error: "x" }, 500));
    const client = new EversysClient({ baseUrl: "https://api.x", token: "tok", machineId: 123, fetchFn: fetchMock });
    await expect(client.fetchBrewsAfter(0, 1)).rejects.toMatchObject({ name: "ApiError", status: 500 });
  });
});
