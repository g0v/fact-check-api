import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LIMITS, MODELS } from "../src/api/config";
import { factCheck } from "../src/api/services/fact-check";
import { claim, harness } from "./helpers";

const requestId = "synthesis-debug-test";

afterEach(() => {
  vi.useRealTimers();
});

function overrideSynthesis(h: ReturnType<typeof harness>, output: unknown) {
  const original = h.run.getMockImplementation()!;
  h.run.mockImplementation(async (model, input) =>
    model === MODELS.synthesis ? output : original(model, input),
  );
}

function expectSynthesisError(h: ReturnType<typeof harness>, expected: Record<string, unknown>) {
  expect(h.log).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "synthesis_error",
      stage: "synthesis",
      model: MODELS.synthesis,
      request_id: requestId,
      ...expected,
    }),
  );
}

describe("綜整診斷紀錄與推理迴圈抑制", () => {
  it("綜整呼叫關閉 thinking 並送出重複抑制參數", async () => {
    const h = harness();
    await factCheck({ text: claim }, h.env, { ...h, requestId });
    const call = h.run.mock.calls.find(([model]) => model === MODELS.synthesis);
    expect(call?.[1]).toMatchObject({
      temperature: 0,
      max_completion_tokens: 4096,
      // frequency_penalty: 0.5,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: "json_object" },
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "synthesis_response",
        stage: "synthesis",
        model: MODELS.synthesis,
        choices_count: 1,
        finish_reason: "stop",
        content_length: expect.any(Number),
        has_reasoning: false,
      }),
    );
    expect(h.log).not.toHaveBeenCalledWith(expect.objectContaining({ event: "synthesis_error" }));
  });

  it("content 為 null 但含 reasoning 時只記錄安全 metadata", async () => {
    const h = harness();
    overrideSynthesis(h, {
      choices: [
        {
          finish_reason: "stop",
          message: { content: null, reasoning_content: "不可寫入 log 的模型推理" },
        },
      ],
      usage: {
        prompt_tokens: 1069,
        completion_tokens: 2775,
        completion_tokens_details: { reasoning_tokens: 2775 },
      },
    });
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
    expect(h.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "synthesis_response",
        choices_count: 1,
        finish_reason: "stop",
        content_length: null,
        has_reasoning: true,
        prompt_tokens: 1069,
        completion_tokens: 2775,
        reasoning_tokens: 2775,
      }),
    );
    expectSynthesisError(h, { reason: "invalid_content", finish_reason: "stop" });
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("不可寫入 log 的模型推理");
  });

  it("輸出達 token 上限（finish_reason: length）記錄 incomplete_completion", async () => {
    const h = harness();
    overrideSynthesis(h, {
      choices: [
        {
          finish_reason: "length",
          message: { content: '{"factuality":0.7,"confidence":0.6,"verdict":"mostly_su' },
        },
      ],
    });
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
    expectSynthesisError(h, { reason: "incomplete_completion", finish_reason: "length" });
    const logs = JSON.stringify(h.log.mock.calls);
    expect(logs).not.toContain("mostly_su");
    expect(logs).not.toContain(claim);
  });

  it("未知完成代碼經白名單過濾為 unknown，不寫入原文", async () => {
    const h = harness();
    overrideSynthesis(h, {
      choices: [{ finish_reason: "上游任意文字", message: { content: "{}" } }],
    });
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
    expectSynthesisError(h, { reason: "incomplete_completion", finish_reason: "unknown" });
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("上游任意文字");
  });

  it("完成但輸出不是有效 JSON 記錄 invalid_content_json", async () => {
    const h = harness();
    overrideSynthesis(h, { choices: [{ finish_reason: "stop", message: { content: "{" } }] });
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
    expectSynthesisError(h, { reason: "invalid_content_json", finish_reason: "stop" });
  });

  it("JSON 有效但違反輸出契約記錄 invalid_synthesis", async () => {
    const h = harness({
      synthesis: { factuality: 0.7, confidence: 0.6, verdict: "pass", feedback: "測試" },
    });
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
    expectSynthesisError(h, { reason: "invalid_synthesis", finish_reason: null });
  });

  it("模型呼叫失敗記錄 model_error", async () => {
    const h = harness({ synthesisFailure: true });
    await expect(factCheck({ text: claim }, h.env, { ...h, requestId })).rejects.toMatchObject({
      status: 502,
      stage: "synthesis",
    });
    expectSynthesisError(h, { reason: "model_error", finish_reason: null });
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("綜整測試失敗");
  });

  it("綜整逾時記錄 timeout 與耗時", async () => {
    vi.useFakeTimers();
    const h = harness();
    overrideSynthesis(h, new Promise(() => undefined));
    const assertion = expect(
      factCheck({ text: claim }, h.env, { ...h, requestId }),
    ).rejects.toMatchObject({ status: 502, stage: "synthesis" });
    await vi.advanceTimersByTimeAsync(LIMITS.modelTimeoutMs + 1);
    await assertion;
    expectSynthesisError(h, { reason: "timeout", latency_ms: LIMITS.modelTimeoutMs });
  });
});
