import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "../src/api";
import { BUDGET } from "../src/api/config";
import { cachedFactCheck } from "../src/api/services/cached-fact-check";
import {
  applyBudgetCommand,
  DAY_MS,
  estimateRequestNeurons,
  resolveDailyLimitNeurons,
  UsageBudget,
  type BudgetLedger,
  type BudgetStorage,
} from "../src/api/services/usage-budget";
import type { ApiBindings, DurableObjectNamespaceLike } from "../src/api/types/fact-check";
import { estimateTokens, readUsage, usageNeurons } from "../src/api/utils/usage";
import { claim, harness } from "./helpers";

const origin = "https://api.example.test";
const input = { text: claim };

function memoryStorage(): BudgetStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
  };
}

// 以記憶體 Durable Object 模擬 binding；fetch 直接交給同一個物件實例。
function budgetNamespace(object: UsageBudget = new UsageBudget({ storage: memoryStorage() })) {
  const fetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) =>
    object.fetch(new Request(request, init)),
  );
  const namespace: DurableObjectNamespaceLike = {
    idFromName: (name) => name,
    get: () => ({ fetch }),
  };
  return { namespace, fetch };
}

function envWithBudget(env: ApiBindings, options: Partial<ApiBindings> = {}): ApiBindings {
  return { ...env, USAGE_BUDGET: budgetNamespace().namespace, ...options };
}

const workersAiStages = ["relevance", "synthesis"] as const;
const reserve = (amountNeurons: number, limitNeurons = 10_000) =>
  ({ action: "reserve", amountNeurons, limitNeurons }) as const;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("每日 Workers AI 用量帳本", () => {
  const now = 1_800_000_000_000;
  const bucket = Math.floor(now / DAY_MS);

  it("預留在上限內累加，超過上限則拒絕並回報 UTC 隔日重設時間", () => {
    const first = applyBudgetCommand(undefined, reserve(4_000), now);
    expect(first.status).toMatchObject({ allowed: true, bucket, spentNeurons: 4_000, requests: 1 });
    const second = applyBudgetCommand(first.ledger, reserve(4_000), now + 1);
    expect(second.status).toMatchObject({ allowed: true, spentNeurons: 8_000, requests: 2 });
    const third = applyBudgetCommand(second.ledger, reserve(4_000), now + 2);
    expect(third.status).toMatchObject({
      allowed: false,
      spentNeurons: 8_000,
      requests: 2,
      rejected: 1,
    });
    expect(third.status.resetAt).toBe((bucket + 1) * DAY_MS);
    expect(third.ledger.spentNeurons).toBe(8_000);
  });

  it("上限為 0 時一律拒絕", () => {
    expect(applyBudgetCommand(undefined, reserve(0, 0), now).status.allowed).toBe(false);
  });

  it("進入新的 UTC 日後重新計算", () => {
    const spent: BudgetLedger = { bucket, spentNeurons: 10_000, requests: 3, rejected: 2 };
    const result = applyBudgetCommand(spent, reserve(4_000), (bucket + 1) * DAY_MS);
    expect(result.status).toMatchObject({
      allowed: true,
      bucket: bucket + 1,
      spentNeurons: 4_000,
      requests: 1,
      rejected: 0,
    });
  });

  it("結算以實際差額修正，不得低於 0，且不套用到其他日期", () => {
    const spent: BudgetLedger = { bucket, spentNeurons: 4_000, requests: 1, rejected: 0 };
    const up = applyBudgetCommand(spent, { action: "settle", bucket, deltaNeurons: 250.5 }, now);
    expect(up.ledger.spentNeurons).toBeCloseTo(4_250.5, 6);
    const down = applyBudgetCommand(spent, { action: "settle", bucket, deltaNeurons: -9_000 }, now);
    expect(down.ledger.spentNeurons).toBe(0);
    const stale = applyBudgetCommand(
      spent,
      { action: "settle", bucket: bucket - 1, deltaNeurons: 250 },
      now,
    );
    expect(stale.ledger.spentNeurons).toBe(4_000);
    expect(stale.status.limitNeurons).toBeNull();
  });

  it("Durable Object 持久化帳本並拒絕格式錯誤的指令", async () => {
    vi.useFakeTimers({ now });
    const storage = memoryStorage();
    const object = new UsageBudget({ storage });
    const post = (body: string) =>
      object.fetch(new Request("https://usage-budget/", { method: "POST", body }));
    const reserved = await post(JSON.stringify(reserve(300)));
    expect(reserved.status).toBe(200);
    expect(await reserved.json()).toMatchObject({
      allowed: true,
      bucket,
      spentNeurons: 300,
      limitNeurons: 10_000,
    });
    expect(storage.data.get("ledger")).toMatchObject({ bucket, spentNeurons: 300 });
    const settled = await post(JSON.stringify({ action: "settle", bucket, deltaNeurons: 100 }));
    expect(await settled.json()).toMatchObject({ spentNeurons: 400 });
    for (const body of ["not json", "{}", JSON.stringify(reserve(-1))]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await object.fetch(new Request("https://usage-budget/"))).status).toBe(400);
  });
});

describe("用量估算與 neurons 換算", () => {
  it("讀取 OpenAI 與 Responses 兩種 usage 欄位，缺少時回 null", () => {
    expect(readUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
    });
    expect(readUsage({ usage: { input_tokens: 7, output_tokens: 3 } })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
    });
    expect(readUsage({ usage: { prompt_tokens: 10 } })).toBeNull();
    expect(readUsage({ response: "{}" })).toBeNull();
    expect(readUsage(null)).toBeNull();
  });

  it("依 Workers AI 公告換算 neurons；安全分類不計入，估算隨文字長度增加", () => {
    expect(usageNeurons("relevance", 1_000_000, 0)).toBe(
      BUDGET.neuronsPerMillionTokens.relevance.input,
    );
    expect(usageNeurons("synthesis", 0, 1_000_000)).toBe(
      BUDGET.neuronsPerMillionTokens.synthesis.output,
    );
    expect(usageNeurons("moderation", 1_000_000, 1_000_000)).toBe(0);
    expect(estimateTokens("一二三")).toBe(2);
    const short = estimateRequestNeurons("短句");
    const long = estimateRequestNeurons("長".repeat(10_000));
    expect(short).toBeGreaterThan(0);
    // 典型查核應遠低於每日免費額度，一天至少能容納十餘次未命中快取的查核。
    expect(short * 10).toBeLessThan(BUDGET.dailyNeurons);
    expect(long).toBeGreaterThan(short);
  });

  it("每日上限可由環境變數覆蓋，無效值採用預設", () => {
    expect(resolveDailyLimitNeurons({})).toBe(BUDGET.dailyNeurons);
    expect(resolveDailyLimitNeurons({ DAILY_NEURON_BUDGET: "5000" })).toBe(5_000);
    expect(resolveDailyLimitNeurons({ DAILY_NEURON_BUDGET: 20_000 })).toBe(20_000);
    expect(resolveDailyLimitNeurons({ DAILY_NEURON_BUDGET: "0" })).toBe(0);
    for (const raw of ["abc", "-1", "", "  "])
      expect(resolveDailyLimitNeurons({ DAILY_NEURON_BUDGET: raw })).toBe(BUDGET.dailyNeurons);
  });
});

describe("查核流程的用量控管", () => {
  const events = (h: ReturnType<typeof harness>) => h.log.mock.calls.map(([event]) => event);

  it("未命中快取時預留額度，查核後以上游回報的 token 結算", async () => {
    const h = harness({ usage: { prompt_tokens: 1_000, completion_tokens: 100 } });
    const { namespace, fetch } = budgetNamespace();
    const env = { ...h.env, USAGE_BUDGET: namespace };
    const result = await cachedFactCheck(input, env, {
      ...h,
      cache: null,
      origin,
      requestId: "r1",
    });
    expect(result.status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(2);
    const commands = await Promise.all(
      fetch.mock.calls.map(([request, init]) => new Request(request, init).json()),
    );
    const expected = estimateRequestNeurons(claim);
    expect(commands[0]).toEqual({
      action: "reserve",
      amountNeurons: expected,
      limitNeurons: BUDGET.dailyNeurons,
    });
    const actual = workersAiStages.reduce((sum, stage) => sum + usageNeurons(stage, 1_000, 100), 0);
    expect(commands[1].action).toBe("settle");
    expect(commands[1].deltaNeurons).toBeCloseTo(actual - expected, 9);
    const usage = events(h).find((event) => event.event === "usage");
    expect(usage).toMatchObject({
      stages: ["moderation", "relevance", "synthesis"],
      prompt_tokens: [1_000, 1_000, 1_000],
      completion_tokens: [100, 100, 100],
      estimated: [false, false, false],
    });
    expect((usage!.neurons as number[])[0]).toBe(0);
    expect(usage!.total_neurons).toBeCloseTo(actual, 9);
    const budget = events(h).filter((event) => event.event === "budget");
    expect(budget.map((event) => [event.operation, event.status])).toEqual([
      ["reserve", "allowed"],
      ["settle", "settled"],
    ]);
    expect(JSON.stringify(h.log.mock.calls)).not.toContain(claim);
  });

  it("上游未回報用量時以字元估算並標記 estimated", async () => {
    const h = harness();
    const result = await cachedFactCheck(input, envWithBudget(h.env), {
      ...h,
      cache: null,
      origin,
    });
    expect(result.status).toBe("completed");
    const usage = events(h).find((event) => event.event === "usage");
    expect(usage).toMatchObject({ estimated: [true, true, true] });
    expect((usage!.prompt_tokens as number[]).every((count) => count > 0)).toBe(true);
    expect(usage!.total_neurons).toBeGreaterThan(0);
  });

  it("今日額度用完後回 429 並附 Retry-After，不呼叫任何上游", async () => {
    // 第一次查核的實際用量結算後已超過上限，第二次應被拒絕。
    const h = harness({ usage: { prompt_tokens: 20_000, completion_tokens: 2_000 } });
    const object = new UsageBudget({ storage: memoryStorage() });
    const env = {
      ...h.env,
      USAGE_BUDGET: budgetNamespace(object).namespace,
      DAILY_NEURON_BUDGET: "400",
    };
    await cachedFactCheck(input, env, { ...h, cache: null, origin });
    const calls = { fetcher: h.fetcher.mock.calls.length, run: h.run.mock.calls.length };
    await expect(cachedFactCheck(input, env, { ...h, cache: null, origin })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      status: 429,
    });
    expect(h.fetcher).toHaveBeenCalledTimes(calls.fetcher);
    expect(h.run).toHaveBeenCalledTimes(calls.run);
    const rejected = events(h).find((event) => event.status === "rejected");
    expect(rejected).toMatchObject({ event: "budget", operation: "reserve", day_rejected: 1 });

    // 透過 API 回應：JSON 錯誤與 Retry-After 秒數不超過距 UTC 隔日的剩餘時間。
    const response = await api.request(`/fact-check?text=${encodeURIComponent(claim)}`, {}, env);
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(await response.json()).toMatchObject({ status: "error", error: "BUDGET_EXCEEDED" });
  });

  it("命中快取不消耗額度也不呼叫 Durable Object", async () => {
    const h = harness();
    const { namespace, fetch } = budgetNamespace();
    const env = { ...h.env, USAGE_BUDGET: namespace };
    const entries = new Map<string, Response>();
    const cache = {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        entries.set(request.url, new Response(await response.text(), response));
      },
    };
    await cachedFactCheck(input, env, { ...h, cache, origin });
    expect(fetch).toHaveBeenCalledTimes(2);
    const hit = await cachedFactCheck(input, env, { ...h, cache, origin });
    expect(hit.meta.cache?.status).toBe("hit");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("安全層封鎖時沒有 Workers AI 用量，結算退回全部預留", async () => {
    const h = harness({ decision: "block", usage: { prompt_tokens: 500, completion_tokens: 50 } });
    const { namespace, fetch } = budgetNamespace();
    const result = await cachedFactCheck(
      input,
      { ...h.env, USAGE_BUDGET: namespace },
      { ...h, cache: null, origin },
    );
    expect(result.status).toBe("blocked");
    const settle = await new Request(...fetch.mock.calls[1]).json();
    expect(settle.deltaNeurons).toBeCloseTo(-estimateRequestNeurons(claim), 9);
    const usage = events(h).find((event) => event.event === "usage");
    expect(usage).toMatchObject({ stages: ["moderation"], total_neurons: 0 });
  });

  it("查核中途失敗仍結算已發生的用量", async () => {
    const h = harness({
      synthesisFailure: true,
      usage: { prompt_tokens: 500, completion_tokens: 50 },
    });
    const { namespace, fetch } = budgetNamespace();
    await expect(
      cachedFactCheck(input, { ...h.env, USAGE_BUDGET: namespace }, { ...h, cache: null, origin }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", stage: "synthesis" });
    // 綜整模型未回應，因此只有初篩一段有 Workers AI 用量。
    const settle = await new Request(...fetch.mock.calls[1]).json();
    expect(settle.deltaNeurons).toBeCloseTo(
      usageNeurons("relevance", 500, 50) - estimateRequestNeurons(claim),
      9,
    );
  });

  it("預算服務失敗時拒絕查核並回 503；結算失敗只記錄", async () => {
    const h = harness();
    const failing: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({ fetch: async () => new Response("錯誤", { status: 500 }) }),
    };
    await expect(
      cachedFactCheck(input, { ...h.env, USAGE_BUDGET: failing }, { ...h, cache: null, origin }),
    ).rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE", status: 503 });
    expect(h.fetcher).not.toHaveBeenCalled();

    let calls = 0;
    const flaky: DurableObjectNamespaceLike = {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request, init) => {
          calls += 1;
          if (calls > 1) throw new Error("結算失敗");
          return new UsageBudget({ storage: memoryStorage() }).fetch(new Request(request, init));
        },
      }),
    };
    const result = await cachedFactCheck(
      input,
      { ...h.env, USAGE_BUDGET: flaky },
      { ...h, cache: null, origin },
    );
    expect(result.status).toBe("completed");
    const settle = events(h).find((event) => event.operation === "settle");
    expect(settle).toMatchObject({ event: "budget", status: "error" });
  });

  it("沒有 Durable Object binding 時略過控管", async () => {
    const h = harness();
    const result = await cachedFactCheck(input, h.env, { ...h, cache: null, origin });
    expect(result.status).toBe("completed");
    const budget = events(h).filter((event) => event.event === "budget");
    expect(budget).toEqual([expect.objectContaining({ operation: "reserve", status: "bypass" })]);
  });
});
