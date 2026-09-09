import { describe, expect, it } from "vite-plus/test";
import { communityPolicy } from "../src/api/prompts/community-policy";
import { factCheck } from "../src/api/services/fact-check";
import { moderate } from "../src/api/services/moderation";
import { claim, completion, harness } from "./helpers";

const allowed = { decision: "allow", categories: [], reason: "可進行查核。" };
const message = { content: JSON.stringify(allowed) };

describe("Safeguard 呼叫契約", () => {
  it("沿用 civic-talk-hono 實測的結構化輸出與推理參數", async () => {
    const h = harness({ moderation: allowed });
    expect(await moderate(claim, h.env, h.fetcher)).toEqual(allowed);
    expect(h.fetcher).toHaveBeenCalledOnce();
    const [url, init] = h.fetcher.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer your-openrouter-api-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "openai/gpt-oss-safeguard-20b",
      messages: [
        { role: "system", content: communityPolicy },
        { role: "user", content: JSON.stringify({ text: claim }) },
      ],
      temperature: 0,
      max_tokens: 1600,
      reasoning: { effort: "low" },
      response_format: {
        type: "json_schema",
        json_schema: {
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              decision: { type: "string", enum: ["allow", "review", "block"] },
              categories: { type: "array", items: { type: "string" } },
              reason: { type: "string" },
            },
            required: ["decision", "categories", "reason"],
          },
        },
      },
    });
  });

  it.each([
    { decision: "review", categories: ["hate"], reason: "引述待查言論，保留查核例外旗標。" },
    { decision: "block", categories: ["privacy"], reason: "直接曝露私人敏感資料。" },
  ])("保留 $decision 的分類與原因", async (moderation) => {
    const h = harness({ moderation });
    expect(await moderate(claim, h.env, h.fetcher)).toEqual(moderation);
  });

  it("模型回 allow 卻附分類時由程式改判 block，保留分類與原因", async () => {
    const h = harness({
      moderation: { decision: "allow", categories: ["hate"], reason: "含有仇恨內容。" },
    });
    expect(await moderate(claim, h.env, h.fetcher)).toEqual({
      decision: "block",
      categories: ["hate"],
      reason: "含有仇恨內容。",
    });
  });

  it.each([
    { name: "輸出達 token 上限", output: { choices: [{ finish_reason: "length", message }] } },
    { name: "缺少結束原因", output: { choices: [{ message }] } },
    { name: "結束原因為 null", output: { choices: [{ finish_reason: null, message }] } },
    {
      name: "上游 choice 帶有錯誤",
      output: { choices: [{ finish_reason: "stop", error: { code: 500 }, message }] },
    },
    {
      name: "只有推理而無最終內容",
      output: {
        choices: [
          { finish_reason: "stop", message: { content: null, reasoning: JSON.stringify(allowed) } },
        ],
      },
    },
    { name: "缺少 choice", output: { choices: [] } },
    { name: "誤用 Workers AI 回應格式", output: { response: JSON.stringify(allowed) } },
    {
      name: "無效 JSON",
      output: { choices: [{ finish_reason: "stop", message: { content: "{" } }] },
    },
    { name: "無效安全分類", output: completion({ ...allowed, decision: "pass" }) },
  ])("$name 時跳過安全分類並以 partial 繼續查核", async ({ output }) => {
    const h = harness();
    h.fetcher.mockResolvedValueOnce(Response.json(output));
    const result = await factCheck({ text: claim, url: "https://example.com" }, h.env, h);
    expect(result.status).toBe("partial");
    expect(result.moderation).toMatchObject({ decision: "skipped", categories: [] });
    expect(result.meta.warnings).toContainEqual({
      stage: "moderation",
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(
      h.fetcher.mock.calls.filter(([url]) => String(url).includes("openrouter.ai")),
    ).toHaveLength(1);
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});
