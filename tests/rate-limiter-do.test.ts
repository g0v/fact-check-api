import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RateLimiterDO } from "../src/api/services/rate-limiter-do";
import { rateLimiterState, rateLimitNamespace } from "./fixtures/rate-limiter";

const FIXED_NOW = Date.UTC(2026, 9, 4);
const REQUEST_URL = "https://rate-limit/?window_ms=60000";

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(FIXED_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("免費 demo 冷卻持久物件", () => {
  it("重建物件後仍保留完整冷卻，到期邊界才允許下一次請求", async () => {
    const state = rateLimiterState();
    const request = () => new RateLimiterDO(state).fetch(new Request(REQUEST_URL));
    expect(await (await request()).json()).toEqual({ allowed: true });
    vi.mocked(Date.now).mockReturnValue(FIXED_NOW + 59_999);
    expect(await (await request()).json()).toEqual({ allowed: false });
    vi.mocked(Date.now).mockReturnValue(FIXED_NOW + 60_000);
    expect(await (await request()).json()).toEqual({ allowed: true });
  });

  it("不同物件實例共用同一份儲存時，十個並發請求只放行一個", async () => {
    const state = rateLimiterState();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => new RateLimiterDO(state).fetch(new Request(REQUEST_URL))),
    );
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(9);
  });

  it("被拒絕的請求不延長冷卻，下一次通過後才開始新的視窗", async () => {
    const state = rateLimiterState();
    const request = () => new RateLimiterDO(state).fetch(new Request(REQUEST_URL));
    expect(await (await request()).json()).toEqual({ allowed: true });
    vi.mocked(Date.now).mockReturnValue(FIXED_NOW + 30_000);
    expect(await (await request()).json()).toEqual({ allowed: false });
    vi.mocked(Date.now).mockReturnValue(FIXED_NOW + 60_000);
    expect(await (await request()).json()).toEqual({ allowed: true });
    vi.mocked(Date.now).mockReturnValue(FIXED_NOW + 90_000);
    expect(await (await request()).json()).toEqual({ allowed: false });
  });

  it("不同 IP 的持久化冷卻互不影響", async () => {
    const namespace = rateLimitNamespace();
    const first = namespace.get(namespace.idFromName("ip:203.0.113.7"));
    const second = namespace.get(namespace.idFromName("ip:203.0.113.8"));
    expect(await (await first.fetch(REQUEST_URL)).json()).toEqual({ allowed: true });
    expect(await (await second.fetch(REQUEST_URL)).json()).toEqual({ allowed: true });
    expect(await (await first.fetch(REQUEST_URL)).json()).toEqual({ allowed: false });
    expect(await (await second.fetch(REQUEST_URL)).json()).toEqual({ allowed: false });
  });

  it.each(["get", "put"] as const)(
    "儲存 %s 失敗時不回傳成功，後續可正常建立冷卻",
    async (method) => {
      const state = rateLimiterState();
      vi.spyOn(state.storage, method).mockRejectedValueOnce(new Error("冷卻儲存失敗。"));
      const request = () => new RateLimiterDO(state).fetch(new Request(REQUEST_URL));
      await expect(request()).rejects.toThrow("冷卻儲存失敗。");
      expect(await (await request()).json()).toEqual({ allowed: true });
      expect(await (await request()).json()).toEqual({ allowed: false });
    },
  );
});
