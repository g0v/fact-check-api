import { describe, expect, it, vi } from "vite-plus/test";
import { api } from "../src/api";
import { RateLimiterDO } from "../src/api/services/rate-limiter-do";
import type { ApiBindings, ServiceBindingLike } from "../src/api/types/fact-check";

function coreBinding(handler?: (request: Request) => Promise<Response>): ServiceBindingLike {
  return {
    fetch: vi.fn(
      handler ??
        (async () => Response.json({ status: "completed", feedback: "由 core service 回傳。" })),
    ),
  };
}

function environment(FACT_CHECK_CORE: ServiceBindingLike): ApiBindings {
  return { FACT_CHECK_CORE };
}

function rateLimitNamespace(): ApiBindings["RATE_LIMIT_DO"] {
  const limiter = new RateLimiterDO();
  return {
    idFromName: (name) => name,
    get: () => ({
      fetch: (request, init) => limiter.fetch(new Request(request, init)),
    }),
  };
}

describe("/api/demo", () => {
  it("將 POST 本文與 query string 轉送到 core 的 /fact-check", async () => {
    const FACT_CHECK_CORE = coreBinding();
    const response = await api.request(
      "https://example.test/demo?trace=1",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ text: "測試主張" }),
      },
      environment(FACT_CHECK_CORE),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "completed",
      feedback: "由 core service 回傳。",
    });
    const request = vi.mocked(FACT_CHECK_CORE.fetch).mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://example.test/fact-check?trace=1");
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({ text: "測試主張" });
  });

  it("core service 失敗時不洩漏錯誤內容，且允許來源仍取得 CORS", async () => {
    const FACT_CHECK_CORE = coreBinding(async () => {
      throw new Error("core private diagnostic");
    });
    const response = await api.request(
      "/demo",
      {
        method: "POST",
        headers: {
          Origin: "https://civic.vtaiwan.tw",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "測試主張" }),
      },
      environment(FACT_CHECK_CORE),
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://civic.vtaiwan.tw");
    expect(await response.text()).not.toContain("core private diagnostic");
  });

  it("不再提供 GET 路由", async () => {
    const FACT_CHECK_CORE = coreBinding();
    const response = await api.request(
      "/demo?text=%E6%B8%AC%E8%A9%A6",
      {},
      environment(FACT_CHECK_CORE),
    );

    expect(response.status).toBe(404);
    expect(FACT_CHECK_CORE.fetch).not.toHaveBeenCalled();
  });

  it("同一 IP 在冷卻視窗內再次請求時回傳 429", async () => {
    const FACT_CHECK_CORE = coreBinding();
    const env = {
      ...environment(FACT_CHECK_CORE),
      RATE_LIMIT_WINDOW_MS: "5000",
      RATE_LIMIT_DO: rateLimitNamespace(),
    };
    const request = () =>
      api.request(
        "/demo",
        {
          method: "POST",
          headers: {
            Origin: "http://localhost",
            "Content-Type": "application/json",
            "cf-connecting-ip": "203.0.113.7",
          },
          body: JSON.stringify({ text: "測試主張" }),
        },
        env,
      );

    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "RATE_LIMITED" });
    expect(limited.headers.get("Retry-After")).toBe("5");
    expect(FACT_CHECK_CORE.fetch).toHaveBeenCalledTimes(1);
  });
});
