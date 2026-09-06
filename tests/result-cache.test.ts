import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../src/api";
import { MODELS, RESULT_CACHE } from "../src/api/config";
import {
  cachedFactCheck,
  createResultCacheKey,
  type ResultCache,
} from "../src/api/services/cached-fact-check";
import { claim, emptySynthesisOutput, harness } from "./helpers";

const origin = "https://api.example.test";
const input = { text: claim };

function memoryCache() {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn<ResultCache["match"]>(async (request) => entries.get(request.url)?.clone()),
    put: vi.fn<ResultCache["put"]>(async (request, response) => {
      expect(request.method).toBe("GET");
      entries.set(request.url, new Response(await response.text(), response));
    }),
  };
  return { cache, entries };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("查核結果快取", () => {
  it("同一問題只執行一次完整 pipeline，命中時更新 request ID 並忠實保留結果", async () => {
    const h = harness();
    const { cache, entries } = memoryCache();
    const first = await cachedFactCheck(input, h.env, { ...h, cache, origin, requestId: "first" });
    expect(first.meta.cache).toEqual({ status: "miss" });
    const calls = h.fetcher.mock.calls.length;
    const second = await cachedFactCheck(input, h.env, {
      ...h,
      cache,
      origin,
      requestId: "second",
    });
    expect(second.meta.cache).toMatchObject({ status: "hit" });
    expect(second).toEqual({
      ...first,
      meta: { ...first.meta, request_id: "second", cache: second.meta.cache },
    });
    expect(h.fetcher).toHaveBeenCalledTimes(calls);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(cache.put).toHaveBeenCalledOnce();
    const stored = [...entries.values()][0];
    expect(stored.headers.get("Cache-Control")).toBe("public, max-age=3600");
    const entry = await stored.clone().json();
    expect(entry.result.meta).not.toHaveProperty("request_id");
    expect(entry.result.meta).not.toHaveProperty("cache");
    expect(entry.result).not.toHaveProperty("text");
    expect(entry.result).not.toHaveProperty("url");
    const key = cache.put.mock.calls[0][0];
    expect(key.url).toMatch(/\/v1\/[a-f0-9]{64}$/);
    const headerNames: string[] = [];
    key.headers.forEach((_value, name) => headerNames.push(name));
    expect(headerNames).toEqual([]);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(claim);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("your-openrouter-api-key");
  });

  it("不同文字、網址、網域與版本不共用快取", async () => {
    const base = await createResultCacheKey(input, origin);
    for (const [data, site] of [
      [{ text: claim + "不同" }, origin],
      [{ text: claim, url: "https://example.org/a" }, origin],
      [{ text: claim, url: "https://example.org/b" }, origin],
      [input, "https://another.example.test"],
    ] as const)
      expect((await createResultCacheKey(data, site)).url).not.toBe(base.url);
    const version = RESULT_CACHE.version;
    const model = MODELS.moderation;
    try {
      Object.assign(RESULT_CACHE, { version: "next" });
      expect((await createResultCacheKey(input, origin)).url).not.toBe(base.url);
      Object.assign(RESULT_CACHE, { version });
      Object.assign(MODELS, { moderation: "test-model" });
      expect((await createResultCacheKey(input, origin)).url).not.toBe(base.url);
    } finally {
      Object.assign(RESULT_CACHE, { version });
      Object.assign(MODELS, { moderation: model });
    }
  });

  it("到期前可命中，到期後重新查核；命中不延長有效期限", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
    const h = harness();
    const { cache } = memoryCache();
    await cachedFactCheck(input, h.env, { ...h, origin, cache });
    vi.setSystemTime(new Date("2026-09-07T00:59:59Z"));
    const hit = await cachedFactCheck(input, h.env, { ...h, origin, cache });
    expect(hit.meta.cache).toEqual({
      status: "hit",
      cached_at: "2026-09-07T00:00:00.000Z",
      expires_at: "2026-09-07T01:00:00.000Z",
    });
    vi.setSystemTime(new Date("2026-09-07T01:00:00Z"));
    expect((await cachedFactCheck(input, h.env, { ...h, origin, cache })).meta.cache?.status).toBe(
      "miss",
    );
    expect(h.run).toHaveBeenCalledTimes(4);
  });

  it.each([{ decision: "block" }, { urlFailure: true }])(
    "封鎖與部分失敗不寫入快取：%j",
    async (options) => {
      const h = harness(options);
      const { cache } = memoryCache();
      for (let n = 0; n < 2; n++)
        await cachedFactCheck({ ...input, url: "https://example.org" }, h.env, {
          ...h,
          cache,
          origin,
        });
      expect(cache.put).not.toHaveBeenCalled();
      expect(
        h.fetcher.mock.calls.filter(([url]) => String(url).includes("openrouter.ai")),
      ).toHaveLength(2);
    },
  );

  it("上游失敗不寫入；證據不足的完整成功結果仍可快取", async () => {
    const failed = harness({ safetyFailure: true });
    const { cache } = memoryCache();
    await expect(
      cachedFactCheck(input, failed.env, { ...failed, cache, origin }),
    ).rejects.toMatchObject({ status: 502 });
    expect(cache.put).not.toHaveBeenCalled();
    const h = harness({ edges: [], synthesis: emptySynthesisOutput });
    await cachedFactCheck(input, h.env, { ...h, cache, origin });
    const hit = await cachedFactCheck(input, h.env, { ...h, cache, origin });
    expect(hit.meta.cache?.status).toBe("hit");
    expect(hit.factuality).toBe(0.5);
    expect(hit.verdict).toBe("insufficient_evidence");
  });

  it.each(["read", "write", "schedule"])(
    "快取 %s 失敗仍回正常結果且不洩漏例外內容",
    async (operation) => {
      const h = harness();
      const { cache } = memoryCache();
      const failure = new Error("your-openrouter-api-key 測試錯誤");
      if (operation === "read") cache.match.mockRejectedValue(failure);
      if (operation === "write") cache.put.mockRejectedValue(failure);
      const waitUntil =
        operation === "schedule"
          ? () => {
              throw failure;
            }
          : undefined;
      const result = await cachedFactCheck(input, h.env, { ...h, cache, origin, waitUntil });
      expect(result.status).toBe("completed");
      expect(JSON.stringify(h.log.mock.calls)).not.toContain(failure.message);
      expect(h.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "cache", operation, status: "error" }),
      );
    },
  );

  it("無 Cache API 或開啟失敗時照常查核", async () => {
    const h = harness();
    for (const storage of [undefined, { open: vi.fn().mockRejectedValue(new Error("測試失敗")) }]) {
      vi.stubGlobal("caches", storage);
      const result = await cachedFactCheck(input, h.env, { ...h, origin });
      expect(result.meta.cache?.status).toBe("bypass");
      expect(result.status).toBe("completed");
    }
  });

  it("開啟快取逾時不阻塞查核", async () => {
    vi.useFakeTimers();
    const h = harness();
    vi.stubGlobal("caches", { open: () => new Promise(() => undefined) });
    const result = cachedFactCheck(input, h.env, { ...h, origin });
    await vi.advanceTimersByTimeAsync(RESULT_CACHE.timeoutMs + 1);
    expect((await result).status).toBe("completed");
  });

  it.each(["json", "shape", "version", "moderation", "future"])(
    "%s 快取異常重新執行安全層與查核",
    async (kind) => {
      const h = harness();
      const { cache, entries } = memoryCache();
      await cachedFactCheck(input, h.env, { ...h, origin, cache });
      const key = [...entries.keys()][0];
      const entry = await entries.get(key)!.clone().json();
      if (kind === "version") entry.version = "old";
      if (kind === "moderation") entry.result.moderation.decision = "block";
      if (kind === "future") entry.cachedAt = Date.now() + 60000;
      entries.set(
        key,
        kind === "json" ? new Response("{") : Response.json(kind === "shape" ? {} : entry),
      );
      const result = await cachedFactCheck(input, h.env, { ...h, origin, cache });
      expect(result.meta.cache?.status).toBe("miss");
      expect(h.run).toHaveBeenCalledTimes(4);
    },
  );

  it("waitUntil 承接寫入，寫入完成前可先回覆", async () => {
    const h = harness();
    const { cache } = memoryCache();
    let finish!: () => void;
    cache.put.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const tasks: Promise<void>[] = [];
    const result = await cachedFactCheck(input, h.env, {
      ...h,
      cache,
      origin,
      waitUntil: (task) => tasks.push(task),
    });
    expect(result.status).toBe("completed");
    expect(tasks).toHaveLength(1);
    finish();
    await Promise.all(tasks);
  });
});

describe("API 快取整合", () => {
  it("GET／POST 正規化後共用結果，且 HTTP 與 body 使用本次 request ID", async () => {
    const h = harness();
    const { cache } = memoryCache();
    vi.stubGlobal("caches", { open: vi.fn().mockResolvedValue(cache) });
    vi.stubGlobal("fetch", h.fetcher);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const first = await api.request(
      `${origin}/fact-check?text=${encodeURIComponent(`  ${claim}  `)}`,
      {},
      h.env,
    );
    expect(first.headers.get("X-Fact-Check-Cache")).toBe("MISS");
    const count = h.fetcher.mock.calls.length;
    const second = await api.request(
      `${origin}/fact-check`,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      h.env,
    );
    expect(second.headers.get("X-Fact-Check-Cache")).toBe("HIT");
    expect(second.headers.get("Cache-Control")).toBe("no-store");
    expect(second.headers.get("X-Request-Id")).not.toBe(first.headers.get("X-Request-Id"));
    expect((await second.json()).meta.request_id).toBe(second.headers.get("X-Request-Id"));
    expect(h.fetcher).toHaveBeenCalledTimes(count);

    const reads = cache.match.mock.calls.length;
    for (const [body, headers, status] of [
      [input, { Origin: "https://other.example.test", "Content-Type": "application/json" }, 403],
      [{ text: "" }, { Origin: origin, "Content-Type": "application/json" }, 400],
    ] as const) {
      const response = await api.request(
        `${origin}/fact-check`,
        { method: "POST", headers, body: JSON.stringify(body) },
        h.env,
      );
      expect(response.status).toBe(status);
    }
    expect(cache.match).toHaveBeenCalledTimes(reads);
  });
});
