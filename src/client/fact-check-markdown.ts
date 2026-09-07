import { safeSourceLink, valueLabel } from "./fact-check-fields";
import { summarizeFactCheck } from "./fact-check-summary";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function markdownText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .replace(/^(\s*)([#>|+-]|\d+[.)])(?=\s)/gm, "$1\\$2");
}

function quoted(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${markdownText(line)}`)
    .join("\n");
}

function markdownUrl(path: string, value: unknown): string | null {
  const url = safeSourceLink(path, value);
  return url ? url.replace(/\\/g, "%5C").replace(/\(/g, "%28").replace(/\)/g, "%29") : null;
}

function labeledValue(path: string, value: unknown): string {
  const label = valueLabel(path, value);
  const raw = typeof value === "string" ? markdownText(value) : String(value);
  return label ? `${markdownText(label)}（${raw}）` : raw;
}

function addSource(lines: string[], item: unknown, index: number): void {
  const source = record(item);
  const typeText =
    (typeof source.type === "string" && valueLabel("related_checks[].type", source.type)) ||
    "查核回覆";
  lines.push(`### ${index + 1}. ${markdownText(typeText)}`, "");
  if (typeof source.text === "string") lines.push(quoted(source.text), "");

  const cofactsUrl = markdownUrl("related_checks[].url", source.url);
  if (cofactsUrl) lines.push(`- Cofacts 原文：[開啟來源](${cofactsUrl})`);
  if (typeof source.classification === "string")
    lines.push(`- Cofacts 分類：${markdownText(source.classification)}`);
  if (typeof source.retrieval_score === "number")
    lines.push(`- 搜尋排序分數（retrieval score）：${source.retrieval_score}`);
  if (typeof source.relevance_score === "number")
    lines.push(`- 語意相關分數（relevance score）：${source.relevance_score}`);

  const references = [
    source.reference_url,
    ...(Array.isArray(source.reference_urls) ? source.reference_urls : []),
  ];
  const safeReferences = [
    ...new Set(
      references
        .map((url) => markdownUrl("related_checks[].reference_urls[]", url))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
  if (safeReferences.length) {
    lines.push("- 引用來源：");
    safeReferences.forEach((url, referenceIndex) =>
      lines.push(`  - [來源 ${referenceIndex + 1}](${url})`),
    );
  }
  lines.push("");
}

export function createFactCheckMarkdown(value: unknown): string | null {
  const summary = summarizeFactCheck(value);
  if (!summary) return null;
  const data = record(value);
  let raw: string;
  try {
    raw = JSON.stringify(value, null, 2);
  } catch {
    return null;
  }

  const lines = ["# 事實查核結果", ""];
  if (typeof data.text === "string") {
    lines.push("## 待查核主張", "", quoted(data.text), "");
  }
  const backgroundUrl = markdownUrl("url", data.url);
  if (backgroundUrl) lines.push(`背景網址：[開啟原始頁面](${backgroundUrl})`, "");

  lines.push("## 判斷結果", "", `- 判斷：${summary.verdictText}（${summary.verdict}）`);
  if (summary.assessment) lines.push(`- 綜合評估：${markdownText(summary.assessment)}`);
  if (summary.factuality !== null) lines.push(`- 支持度（factuality）：${summary.factuality}`);
  if (summary.confidence !== null) lines.push(`- 信心（confidence）：${summary.confidence}`);
  lines.push("");

  if (summary.feedback) lines.push("## 查核說明", "", quoted(summary.feedback), "");

  lines.push("## 查核來源", "");
  if (!summary.relatedChecks?.length) lines.push("本次沒有取得相關查核來源。", "");
  else summary.relatedChecks.forEach((item, index) => addSource(lines, item, index));

  lines.push("## 流程資訊", "");
  if (data.status !== undefined) lines.push(`- 流程狀態：${labeledValue("status", data.status)}`);
  const moderation = record(data.moderation);
  if (moderation.decision !== undefined)
    lines.push(`- 安全分類：${labeledValue("moderation.decision", moderation.decision)}`);
  if (Array.isArray(moderation.categories))
    lines.push(
      `- 安全分類類別：${moderation.categories.length ? moderation.categories.map((item) => markdownText(String(item))).join("、") : "無"}`,
    );
  if (typeof moderation.reason === "string")
    lines.push(`- 安全分類說明：${markdownText(moderation.reason)}`);

  const meta = record(data.meta);
  const metaFields: Array<[string, string]> = [
    ["request_id", "請求識別碼"],
    ["cofacts_candidates", "Cofacts 候選數"],
    ["cofacts_relevant", "Cofacts 相關文章數"],
    ["cofacts_human_checks", "人工查核數"],
    ["cofacts_ai_checks", "AI 回覆數"],
    ["url_context_used", "是否使用網址背景"],
    ["no_relevant_evidence", "是否查無相關證據"],
  ];
  for (const [key, label] of metaFields) {
    if (meta[key] !== undefined) lines.push(`- ${label}：${markdownText(String(meta[key]))}`);
  }
  const cache = record(meta.cache);
  if (cache.status !== undefined)
    lines.push(`- 快取狀態：${labeledValue("meta.cache.status", cache.status)}`);
  if (typeof cache.cached_at === "string")
    lines.push(`- 快取建立時間：${markdownText(cache.cached_at)}`);
  if (typeof cache.expires_at === "string")
    lines.push(`- 快取到期時間：${markdownText(cache.expires_at)}`);

  if (Array.isArray(meta.warnings) && meta.warnings.length) {
    lines.push("", "### 流程警告", "");
    meta.warnings.forEach((item) => {
      const warning = record(item);
      const parts = [
        warning.stage === undefined ? null : labeledValue("meta.warnings[].stage", warning.stage),
        warning.code === undefined ? null : markdownText(String(warning.code)),
        warning.article_id === undefined
          ? null
          : `文章 ${markdownText(String(warning.article_id))}`,
      ].filter((part): part is string => Boolean(part));
      lines.push(`- ${parts.join(" · ")}`);
    });
  }

  lines.push("", "## 完整 API 回應", "", "```json", raw, "```", "");
  return lines.join("\n");
}

export function factCheckMarkdownFilename(value: unknown, now = new Date()): string {
  const requestId = record(record(value).meta).request_id;
  if (typeof requestId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(requestId))
    return `fact-check-${requestId}.md`;
  const timestamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/:/g, "-");
  return `fact-check-${timestamp}.md`;
}

export function downloadFactCheckMarkdown(value: unknown): boolean {
  const markdown = createFactCheckMarkdown(value);
  if (!markdown || typeof document === "undefined") return false;
  const objectUrl = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = factCheckMarkdownFilename(value);
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }
  return true;
}
