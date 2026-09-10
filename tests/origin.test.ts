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

describe("POST 來源限制", () => {
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
    "不開放允許清單外的 OPTIONS 預檢：%s",
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

// 議題 #29：正式站前端與 API 不同網域，POST 需要 CORS 預檢與授權標頭。
describe("POST 跨來源允許清單", () => {
  const allowed = [
    "https://civic.vtaiwan.tw",
    "https://check.vtaiwan.tw",
    "http://localhost:5173",
    "http://127.0.0.1:8787",
  ];

  it.each(allowed)("預檢回 204 與跨來源授權標頭：%s", async (requestOrigin) => {
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
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(requestOrigin);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(response.headers.get("Vary")).toBe("Origin");
    // 端點不使用 cookie 或身分，預檢一律不開放帶憑證的跨來源請求。
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each(allowed)("接受允許清單內的跨來源 POST：%s", async (requestOrigin) => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    const response = await app.request(
      endpoint,
      {
        method: "POST",
        headers: { Origin: requestOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ text: claim }),
      },
      h.env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "completed" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(requestOrigin);
    expect(response.headers.get("Vary")).toBe("Origin");
    // 跨來源 JS 讀不到未列入 expose 的自訂標頭。
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
      "Retry-After, X-Fact-Check-Cache, X-Request-Id",
    );
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("跨來源 POST 的錯誤回應也帶授權標頭，讓前端讀得到錯誤內容", async () => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    const response = await app.request(
      endpoint,
      {
        method: "POST",
        headers: { Origin: "https://civic.vtaiwan.tw", "Content-Type": "application/json" },
        body: "無效 JSON",
      },
      h.env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: "error", error: "INVALID_INPUT" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://civic.vtaiwan.tw");
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://civic.vtaiwan.tw.attacker.test",
    "http://civic.vtaiwan.tw",
    "https://localhost:5173",
    "http://localhost",
  ])("不放行近似或未列入清單的來源：%s", async (requestOrigin) => {
    const h = harness();
    vi.stubGlobal("fetch", h.fetcher);
    for (const method of ["OPTIONS", "POST"]) {
      const response = await app.request(
        endpoint,
        {
          method,
          headers: { Origin: requestOrigin, "Content-Type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify({ text: claim }) } : {}),
        },
        h.env,
      );
      expect(response.status).toBe(403);
      expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    }
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });
});
