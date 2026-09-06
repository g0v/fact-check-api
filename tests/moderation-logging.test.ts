import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LIMITS } from "../src/api/config";
import { factCheck } from "../src/api/services/fact-check";
import { claim, completion, harness } from "./helpers";

const requestId = "moderation-debug-test";
const privateText = "your-openrouter-api-key 測試用私人內容";
const blocked = { decision: "block", categories: [], reason: privateText };

afterEach(() => {
  vi.useRealTimers();
});

function expectSafeLogs(h: ReturnType<typeof harness>) {
  const logs = JSON.stringify(h.log.mock.calls);
  expect(logs).not.toContain("your-openrouter-api-key");
  expect(logs).not.toContain(privateText);
  expect(logs).not.toContain(claim);
  for (const [event] of h.log.mock.calls) expect(event.request_id).toBe(requestId);
}

describe("Safeguard 診斷紀錄", () => {
  it.each([undefined, "", "   "])(
    "缺少或空白 binding（%j）時記錄讀取前後並停止送出",
    async (apiKey) => {
      const h = harness();
      h.env.OPENROUTER_API_KEY = apiKey;
      await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
        status: 502,
        stage: "moderation",
      });
      const events = h.log.mock.calls.map(([event]) => event);
      expect(events.map((event) => event.event)).toEqual([
        "request",
        "moderation_config",
        "moderation_config",
        "moderation_error",
        "stage",
      ]);
      expect(events[0].openrouter_api_key_present).toBe(apiKey !== undefined);
      expect(events[1].step).toBe("before_read");
      expect(events[2]).toMatchObject({
        step: "after_read",
        api_key_present: apiKey !== undefined,
        api_key_is_string: typeof apiKey === "string",
        api_key_configured: false,
      });
      expect(events[3]).toMatchObject({ reason: "missing_api_key", upstream_status: null });
      expect(h.fetcher).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();
      expectSafeLogs(h);
    },
  );

  it("binding 傳到 Safeguard 後記錄送出、HTTP 與 token 用量，所有紀錄使用相同 request ID", async () => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(
      Response.json({
        ...completion(blocked),
        usage: {
          prompt_tokens: 123,
          completion_tokens: 456,
          completion_tokens_details: { reasoning_tokens: 400 },
        },
      }),
    );
    expect((await factCheck({ text: claim }, h.env, { ...h, requestId })).status).toBe("blocked");
    const events = h.log.mock.calls.map(([event]) => event);
    expect(events.map((event) => event.event)).toEqual([
      "request",
      "moderation_config",
      "moderation_config",
      "moderation_request",
      "moderation_http_response",
      "moderation_response",
      "stage",
      "moderation",
    ]);
    expect(events[2]).toMatchObject({
      step: "after_read",
      api_key_present: true,
      api_key_configured: true,
    });
    expect(events[3]).toMatchObject({
      api_key_configured: true,
      timeout_ms: LIMITS.modelTimeoutMs,
    });
    expect(events[4]).toMatchObject({ upstream_status: 200 });
    expect(events[5]).toMatchObject({
      finish_reason: "stop",
      choices_count: 1,
      prompt_tokens: 123,
      completion_tokens: 456,
      reasoning_tokens: 400,
    });
    expectSafeLogs(h);
  });

  it.each([400, 401, 402, 403, 404, 429, 500, 503])(
    "記錄 HTTP %i 且不記錄上游錯誤本文或 headers",
    async (status) => {
      const h = harness();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(privateText));
        },
        cancel,
      });
      h.fetcher.mockResolvedValueOnce(
        new Response(body, {
          status,
          headers: {
            "set-cookie": "your-cookie-placeholder",
            "x-request-id": "your-openrouter-api-key",
          },
        }),
      );
      await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
        status: 502,
      });
      expect(h.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "moderation_error",
          reason: "http_error",
          upstream_status: status,
        }),
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(h.fetcher).toHaveBeenCalledOnce();
      expect(h.run).not.toHaveBeenCalled();
      expect(JSON.stringify(h.log.mock.calls)).not.toContain("your-cookie-placeholder");
      expectSafeLogs(h);
    },
  );

  it.each([
    { name: "非物件回應", output: null, reason: "invalid_completion" },
    { name: "空 choices", output: { choices: [] }, reason: "invalid_completion" },
    {
      name: "缺少 message",
      output: { choices: [{ finish_reason: "stop" }] },
      reason: "invalid_completion",
    },
    {
      name: "頂層錯誤",
      output: { error: { code: 503, message: privateText } },
      reason: "upstream_error",
      metadata: { upstream_error_code: 503 },
    },
    {
      name: "choice 錯誤",
      output: { choices: [{ error: { code: 500, message: privateText } }] },
      reason: "choice_error",
      metadata: { choice_error_code: 500 },
    },
    {
      name: "截斷回應",
      output: {
        choices: [{ finish_reason: "length" }],
        usage: { completion_tokens: 1600, completion_tokens_details: { reasoning_tokens: 1600 } },
      },
      reason: "incomplete_completion",
      metadata: { finish_reason: "length", completion_tokens: 1600, reasoning_tokens: 1600 },
    },
    {
      name: "只有推理",
      output: {
        choices: [{ finish_reason: "stop", message: { content: null, reasoning: privateText } }],
      },
      reason: "invalid_content",
      metadata: { has_reasoning: true, content_length: null },
    },
    {
      name: "空白內容",
      output: { choices: [{ finish_reason: "stop", message: { content: "   " } }] },
      reason: "invalid_content",
    },
    {
      name: "模型輸出不是 JSON",
      output: { choices: [{ finish_reason: "stop", message: { content: privateText } }] },
      reason: "invalid_content_json",
    },
    {
      name: "判定 schema 錯誤",
      output: completion({ decision: privateText }),
      reason: "invalid_moderation",
    },
    {
      name: "上游任意診斷欄位",
      output: {
        error: { code: privateText, message: privateText, metadata: { raw: privateText } },
        choices: [
          {
            finish_reason: privateText,
            error: { code: privateText },
            message: { content: privateText, reasoning_details: [{ text: privateText }] },
          },
        ],
        usage: {
          prompt_tokens: privateText,
          completion_tokens: -1,
          completion_tokens_details: { reasoning_tokens: privateText },
        },
        model: privateText,
        provider: privateText,
      },
      reason: "upstream_error",
      metadata: {
        upstream_error_code: null,
        choice_error_code: null,
        finish_reason: "unknown",
        prompt_tokens: null,
        completion_tokens: null,
        reasoning_tokens: null,
      },
    },
  ])("可區分 $name 並避免將私人內容寫入 log", async ({ output, reason, metadata }) => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json(output));
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "moderation_error",
        reason,
        upstream_status: 200,
        ...metadata,
      }),
    );
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(h.run).not.toHaveBeenCalled();
    expectSafeLogs(h);
  });

  it.each([
    {
      reason: "network_error",
      upstreamStatus: null,
      response: () => {
        throw new Error(privateText);
      },
    },
    {
      reason: "invalid_response_json",
      upstreamStatus: 200,
      response: () => new Response(privateText),
    },
    {
      reason: "response_too_large",
      upstreamStatus: 200,
      response: () => new Response(" ".repeat(LIMITS.upstreamBytes + 1)),
    },
    {
      reason: "response_read_error",
      upstreamStatus: 200,
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(privateText));
            },
          }),
        ),
    },
  ])("傳輸失敗回報 $reason", async ({ reason, upstreamStatus, response }) => {
    const h = harness();
    h.fetcher.mockImplementationOnce(async () => response());
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "moderation_error",
        reason,
        upstream_status: upstreamStatus,
      }),
    );
    expect(h.run).not.toHaveBeenCalled();
    expectSafeLogs(h);
  });

  it.each([false, true])("連線或讀取本文逾時可辨識（已收到 headers：%s）", async (hasHeaders) => {
    vi.useFakeTimers();
    const h = harness();
    const cancel = vi.fn();
    h.fetcher.mockImplementationOnce(async () =>
      hasHeaders
        ? new Response(new ReadableStream({ cancel }))
        : new Promise<Response>(() => undefined),
    );
    const assertion = expect(
      factCheck({ text: claim }, h.env, { ...h, requestId }),
    ).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(LIMITS.modelTimeoutMs + 1);
    await assertion;
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "moderation_error",
        reason: "timeout",
        upstream_status: hasHeaders ? 200 : null,
        latency_ms: LIMITS.modelTimeoutMs,
      }),
    );
    expect(h.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    if (hasHeaders) expect(cancel).toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expectSafeLogs(h);
  });
});
