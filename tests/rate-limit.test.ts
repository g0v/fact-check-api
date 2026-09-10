import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../src/api";
import { RATE_LIMIT } from "../src/api/config";
import { ipRateLimitKeyFromIp, resolveRateLimitWindowMs } from "../src/api/middleware/rate-limit";
import { RateLimiterDO } from "../src/api/services/rate-limiter-do";
import type { DurableObjectNamespaceLike } from "../src/api/types/fact-check";
import { claim, harness } from "./helpers";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 以記憶體 Durable Object 模擬 binding；比照 tests/usage-budget.test.ts 的 fake 方式。
// 同一 namespace 共用一個物件實例，模擬 idFromName 將同 key 路由到同一顆物件。
function rateLimitNamespace(object: RateLimiterDO = new RateLimiterDO()): {
  namespace: DurableObjectNamespaceLike;
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) =>
    object.fetch(new Request(request, init)),
  );
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => name,
    get: () => ({ fetch }),
  };
  return { namespace, fetch };
}

// 每個測試內把上游 fetch 換成 harness 假回應（比照 tests/fact-check.test.ts 的做法），
// 並靜音 console.info 的結構化日誌。
function setupUpstream() {
  const h = harness();
  vi.stubGlobal("fetch", h.fetcher);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  return h.env;
}

describe("IP 限流 key 正規化", () => {
  it("IPv4 用完整 IP 當 key，不同 IP 不同 key", () => {
    expect(ipRateLimitKeyFromIp("203.0.113.7")).toBe("ip:203.0.113.7");
    expect(ipRateLimitKeyFromIp(" 198.51.100.1 ")).toBe("ip:198.51.100.1");
    expect(ipRateLimitKeyFromIp("203.0.113.7")).not.toBe(ipRateLimitKeyFromIp("203.0.113.8"));
  });

  it("IPv6 同 /64 內不同位址收斂到同一 key", () => {
    expect(ipRateLimitKeyFromIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("ip6:2001:db8:1:2::/64");
    expect(ipRateLimitKeyFromIp("2001:DB8:1:2::1")).toBe("ip6:2001:db8:1:2::/64");
    expect(ipRateLimitKeyFromIp("2001:db8:1:2:ffff::")).toBe("ip6:2001:db8:1:2::/64");
  });

  it("不同 /64 前綴得到不同 key", () => {
    expect(ipRateLimitKeyFromIp("2001:db8:1:2::1")).not.toBe(
      ipRateLimitKeyFromIp("2001:db8:1:3::1"),
    );
  });

  it("無法解析的 IPv6 保留原字串，仍可限流", () => {
    expect(ipRateLimitKeyFromIp("2001:db8::1::2")).toBe("ip:2001:db8::1::2");
  });
});

describe("限流視窗設定", () => {
  it("接受 binding 的字串或數字覆蓋值", () => {
    expect(resolveRateLimitWindowMs({ RATE_LIMIT_WINDOW_MS: "5000" })).toBe(5_000);
    expect(resolveRateLimitWindowMs({ RATE_LIMIT_WINDOW_MS: 1_500 })).toBe(1_500);
  });

  it("缺漏或無效值採用預設視窗", () => {
    for (const raw of [undefined, "", "oops", "0", 0, -1, Number.NaN]) {
      expect(resolveRateLimitWindowMs({ RATE_LIMIT_WINDOW_MS: raw })).toBe(RATE_LIMIT.windowMs);
    }
  });
});

describe("同 IP 流量限制", () => {
  it("無 cf-connecting-ip 時不限流，連續請求都放行", async () => {
    const first = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      {},
      setupUpstream(),
    );
    expect(first.status).toBe(200);
    const second = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      {},
      setupUpstream(),
    );
    expect(second.status).toBe(200);
  });

  it("冷卻視窗內第二次請求被擋，回 429 與 Retry-After", async () => {
    const { namespace, fetch } = rateLimitNamespace();
    const env = {
      ...setupUpstream(),
      RATE_LIMIT_WINDOW_MS: "5000",
      RATE_LIMIT_DO: namespace,
    };
    const headers = { "cf-connecting-ip": "203.0.113.7" };

    const first = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers },
      env,
    );
    expect(first.status).toBe(200);
    const second = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers },
      env,
    );
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      status: "error",
      error: "RATE_LIMITED",
      message: "請求過於頻繁，請稍後再試。",
    });
    expect(second.headers.get("retry-after")).toBe("5");

    // 同一 key 一顆 DO：兩次請求都路由到同一個物件。
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith("https://rate-limit/?window_ms=5000");
  });

  // 議題 #29：跨來源 POST 前的預檢若計入冷卻，同一次操作的 POST 會被自己的預檢擋成 429。
  it("OPTIONS 預檢不耗用冷卻視窗，隨後的跨來源 POST 仍放行", async () => {
    const { namespace, fetch } = rateLimitNamespace();
    const env = { ...setupUpstream(), RATE_LIMIT_DO: namespace };
    const headers = { Origin: "https://civic.vtaiwan.tw", "cf-connecting-ip": "203.0.113.7" };

    const preflight = await api.request(
      "/fact-check",
      { method: "OPTIONS", headers: { ...headers, "Access-Control-Request-Method": "POST" } },
      env,
    );
    expect(preflight.status).toBe(204);
    const post = await api.request(
      "/fact-check",
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ text: claim }),
      },
      env,
    );
    expect(post.status).toBe(200);
    // 只有 POST 查詢限流服務；預檢完全不進入限流流程。
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("不同 IP 互不影響冷卻", async () => {
    // 模擬 idFromName 路由：不同 key 各自一顆物件，冷卻互不影響。
    const objects: Record<string, RateLimiterDO> = {};
    const namespace: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: (id) => {
        const key = String(id);
        objects[key] ??= new RateLimiterDO();
        const object = objects[key];
        return {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            object.fetch(new Request(input, init)),
        };
      },
    };
    const env = { ...setupUpstream(), RATE_LIMIT_DO: namespace };
    const statusFor = async (ip: string) =>
      (
        await api.request(
          `/fact-check?text=${encodeURIComponent(claim)}`,
          { headers: { "cf-connecting-ip": ip } },
          env,
        )
      ).status;
    expect(await statusFor("203.0.113.7")).toBe(200);
    expect(await statusFor("203.0.113.8")).toBe(200);
  });

  it("視窗過後放行", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const { namespace } = rateLimitNamespace();
    const env = { ...setupUpstream(), RATE_LIMIT_DO: namespace };
    const headers = { "cf-connecting-ip": "203.0.113.7" };

    expect(
      (await api.request(`/fact-check?text=${encodeURIComponent(claim)}`, { headers }, env)).status,
    ).toBe(200);
    vi.advanceTimersByTime(RATE_LIMIT.windowMs + 1);
    expect(
      (await api.request(`/fact-check?text=${encodeURIComponent(claim)}`, { headers }, env)).status,
    ).toBe(200);
  });

  it("IPv6 同 /64 輪換位址共享同一份冷卻", async () => {
    const { namespace } = rateLimitNamespace();
    const env = { ...setupUpstream(), RATE_LIMIT_DO: namespace };
    const first = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers: { "cf-connecting-ip": "2001:db8:1:2::1" } },
      env,
    );
    expect(first.status).toBe(200);
    const second = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers: { "cf-connecting-ip": "2001:db8:1:2:abcd::1" } },
      env,
    );
    expect(second.status).toBe(429);
  });

  it("bindings 未綁定時整個機制為 no-op；帶 IP 也不擋", async () => {
    const headers = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 3; i += 1) {
      const response = await api.request(
        `/fact-check?text=${encodeURIComponent(claim)}`,
        { headers },
        setupUpstream(),
      );
      expect(response.status).toBe(200);
    }
  });

  it("DO 檢查出錯時優雅降級放行", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: DurableObjectNamespaceLike = {
      idFromName: () => "broken",
      get: () => ({
        fetch: async () => {
          throw new Error("DO 測試錯誤");
        },
      }),
    };
    const env = { ...setupUpstream(), RATE_LIMIT_DO: broken };
    const response = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers: { "cf-connecting-ip": "203.0.113.7" } },
      env,
    );
    expect(response.status).toBe(200);
    expect(consoleError).toHaveBeenCalled();
  });

  it("DO 回傳錯誤狀態或無效格式時優雅降級放行", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const response of [
      Response.json({ error: "測試錯誤" }, { status: 500 }),
      Response.json({ allowed: "yes" }),
    ]) {
      const namespace: DurableObjectNamespaceLike = {
        idFromName: (name) => name,
        get: () => ({ fetch: async () => response.clone() }),
      };
      const env = { ...setupUpstream(), RATE_LIMIT_DO: namespace };
      const result = await api.request(
        `/fact-check?text=${encodeURIComponent(claim)}`,
        { headers: { "cf-connecting-ip": "203.0.113.7" } },
        env,
      );
      expect(result.status).toBe(200);
    }
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it("內建限流 binding 拒絕時直接擋下", async () => {
    const env = {
      ...setupUpstream(),
      RATE_LIMITER: { limit: async () => ({ success: false }) },
      RATE_LIMIT_DO: rateLimitNamespace().namespace,
    };
    const response = await api.request(
      `/fact-check?text=${encodeURIComponent(claim)}`,
      { headers: { "cf-connecting-ip": "203.0.113.7" } },
      env,
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: "RATE_LIMITED" });
  });
});

describe("RateLimiterDO 冷卻", () => {
  it("視窗內第二次拒絕，視窗過後重新允許", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const object = new RateLimiterDO();
    const get = (windowMs: number) =>
      object.fetch(new Request(`https://rate-limit/?window_ms=${windowMs}`));
    expect(await (await get(3_000)).json()).toEqual({ allowed: true });
    expect(await (await get(3_000)).json()).toEqual({ allowed: false });
    vi.advanceTimersByTime(3_001);
    expect(await (await get(3_000)).json()).toEqual({ allowed: true });
  });

  it("window_ms 缺漏或無效時採用預設視窗", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const object = new RateLimiterDO();
    const get = () => object.fetch(new Request("https://rate-limit/"));
    expect(await (await get()).json()).toEqual({ allowed: true });
    expect(await (await get()).json()).toEqual({ allowed: false });
    vi.advanceTimersByTime(RATE_LIMIT.windowMs + 1);
    expect(await (await get()).json()).toEqual({ allowed: true });
  });

  it("window_ms 為非正數時採用預設視窗", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const object = new RateLimiterDO();
    const get = () => object.fetch(new Request("https://rate-limit/?window_ms=-1"));
    expect(await (await get()).json()).toEqual({ allowed: true });
    expect(await (await get()).json()).toEqual({ allowed: false });
  });
});
