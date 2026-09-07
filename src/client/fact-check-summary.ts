import { valueLabel } from "./fact-check-fields";

// 信心分級：0.5 為 issue #10 常識判斷的下修上限，必須落在「不大肯定」，故中段採嚴格大於。
export function confidenceText(confidence: number): string {
  if (confidence >= 0.75) return "可確信";
  if (confidence > 0.5) return "可相當確信";
  if (confidence >= 0.25) return "不大肯定";
  return "非常不肯定";
}

export function factualityText(factuality: number, verdict: string): string {
  if (verdict === "insufficient_evidence") return "此陳述依查核資料無法判定";
  if (factuality >= 0.8) return "此陳述為真";
  if (factuality >= 0.6) return "此陳述大致為真";
  // 0.5 整是「無法判定」的慣用值，不落入真偽參半。
  if (factuality === 0.5) return "此陳述依查核資料無法判定";
  if (factuality > 0.35) return "此陳述真偽參半";
  if (factuality > 0.2) return "此陳述大致為假";
  return "此陳述為假";
}

export type FactCheckSummary = {
  verdict: string;
  verdictText: string;
  factuality: number | null;
  confidence: number | null;
  assessment: string | null;
  feedback: string | null;
  relatedChecks: unknown[] | null;
  rest: Record<string, unknown>;
};

export function summarizeFactCheck(value: unknown): FactCheckSummary | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const verdict = data.verdict;
  if (typeof verdict !== "string") return null;
  // 未知的 verdict 值不猜測含義，交回逐項呈現。
  const verdictText = valueLabel("verdict", verdict);
  if (!verdictText) return null;
  const factuality = typeof data.factuality === "number" ? data.factuality : null;
  const confidence = typeof data.confidence === "number" ? data.confidence : null;
  const feedback = typeof data.feedback === "string" ? data.feedback : null;
  const relatedChecks = Array.isArray(data.related_checks) ? data.related_checks : null;
  const assessment =
    factuality !== null && confidence !== null
      ? `${confidenceText(confidence)}，${factualityText(factuality, verdict)}`
      : null;
  // 只移除摘要實際呈現的欄位；型別不符的值保留在後段逐項顯示，不默默隱藏。
  const rest: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(data)) {
    const consumed =
      key === "verdict" ||
      (key === "factuality" && factuality !== null) ||
      (key === "confidence" && confidence !== null) ||
      (key === "feedback" && feedback !== null) ||
      (key === "related_checks" && relatedChecks !== null);
    if (!consumed) rest[key] = item;
  }
  return {
    verdict,
    verdictText,
    factuality,
    confidence,
    assessment,
    feedback,
    relatedChecks,
    rest,
  };
}
