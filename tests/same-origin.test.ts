import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import app from "../src/index";
import { claim, harness } from "./helpers";

const origin = "https://api.example.test";
const endpoint = `${origin}/api/fact-check`;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST 同源限制", () => {
  it.each([
    undefined,
    "",
    "null",
    "https://other.example.test",
    "https://app.api.example.test",
    "https://api.example.test.attacker.test",
    "http://api.example.test",
    "https://api.example.test:8443",
    "https://api.example.test/",
    "https://api.example.test/path",
    "https://api.example.test https://other.example.test",
  ])("拒絕不符的 Origin：%s，且不執行查核", async (requestOrigin) => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    const headers = new Headers({ "Content-Type": "application/json" });
    if (requestOrigin !== undefined) headers.set("Origin", requestOrigin);
    const response = await app.request(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ text: claim }),
      },
      h.env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      status: "error",
      error: "FORBIDDEN_ORIGIN",
      request_id: response.headers.get("X-Request-Id"),
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each([origin, "http://localhost:5173", "https://custom.example.test:8443"])(
    "接受與目前站台完全相符的 Origin：%s",
    async (siteOrigin) => {
      const h = harness();
      vi.stubGlobal("fetch", h.fetcher);
      const response = await app.request(
        `${siteOrigin}/api/fact-check`,
        {
          method: "POST",
          headers: { Origin: siteOrigin, "Content-Type": "application/json" },
          body: JSON.stringify({ text: claim }),
        },
        h.env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "completed" });
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
      expect(h.run).toHaveBeenCalledTimes(2);
    },
  );

  it("不以 Referer、Host 或代理標頭替代或改寫預期 Origin", async () => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    for (const requestOrigin of [undefined, "https://other.example.test"]) {
      const response = await app.request(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Referer: `${origin}/`,
            Host: "other.example.test",
            "X-Forwarded-Host": "other.example.test",
            "X-Forwarded-Proto": "https",
            "Sec-Fetch-Site": "same-origin",
            ...(requestOrigin ? { Origin: requestOrigin } : {}),
          },
          body: JSON.stringify({ text: claim }),
        },
        h.env,
      );
      expect(response.status).toBe(403);
    }
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("先檢查 Origin，再處理本文或輸入限制", async () => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    const response = await app.request(
      endpoint,
      {
        method: "POST",
        headers: { Origin: "https://other.example.test", "Content-Length": "999999" },
        body: "無效 JSON",
      },
      h.env,
    );
    expect(response.status).toBe(403);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each([origin, "https://other.example.test", "null"])(
    "不開放 OPTIONS 預檢：%s",
    async (requestOrigin) => {
      const h = harness();
      vi.stubGlobal("fetch", h.fetcher);
      const response = await app.request(
        endpoint,
        {
          method: "OPTIONS",
          headers: {
            Origin: requestOrigin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
          },
        },
        h.env,
      );
      expect(response.status).toBe(403);
      for (const header of [
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Methods",
        "Access-Control-Allow-Headers",
      ]) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();
    },
  );

  it("GET 保留原有公開呼叫行為", async () => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    const response = await app.request(
      `${endpoint}?text=${encodeURIComponent(claim)}`,
      {
        headers: { Origin: "https://other.example.test" },
      },
      h.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed" });
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
});
