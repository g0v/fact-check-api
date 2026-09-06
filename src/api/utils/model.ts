import { record, array, string } from "./validation";

// gpt-oss 使用 response；Gemma 與 OpenRouter 使用 chat completion choices。
export function parseModelJson(value: unknown): unknown {
  const output = record(value);
  let content: string;
  if (typeof output.response === "string") {
    content = string(output.response, 64_000);
  } else {
    const choice = record(array(output.choices)[0]);
    if (choice.finish_reason && choice.finish_reason !== "stop") {
      throw new Error("模型未完整輸出結果。");
    }
    content = string(record(choice.message).content, 64_000);
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content);
  return JSON.parse(fenced ? fenced[1] : content);
}
