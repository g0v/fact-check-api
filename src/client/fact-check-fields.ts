type FieldInfo = { label: string; description: string };

const fields: Record<string, FieldInfo> = {
  text: { label: "待查核文字", description: "API 回傳的本次查核主張。" },
  url: { label: "補充網址", description: "本次提供的背景網址；提供網址不表示來源已被認定可信。" },
  status: {
    label: "處理狀態",
    description:
      "completed：流程完成；partial：部分服務失敗；blocked：安全層停止查核；error：請求失敗。流程完成仍可能是證據不足。",
  },
  moderation: {
    label: "安全分類",
    description: "Safeguard 對內容安全的判定，不負責判斷主張真假。",
  },
  "moderation.decision": {
    label: "安全決策",
    description: "allow：繼續查核；review：繼續但保留敏感旗標；block：停止查核。",
  },
  "moderation.categories": {
    label: "安全分類代碼",
    description: "涉及的內容安全類別；空陣列表示沒有列出類別。",
  },
  "moderation.reason": { label: "安全分類原因", description: "安全分類模型回傳的判定理由。" },
  factuality: {
    label: "證據支持程度",
    description:
      "0～1 的原始值，表示證據支持主張的程度，不是主張為真的機率。無證據時的 0.5 表示無法判定；null 表示沒有產生分數。",
  },
  confidence: {
    label: "判斷信心",
    description:
      "0～1 的原始值，反映證據是否充分、可靠且一致；應搭配證據支持程度閱讀。null 表示沒有產生分數。",
  },
  verdict: { label: "綜合判斷", description: "依據證據產生的判斷代碼；null 表示沒有產生判斷。" },
  feedback: { label: "查核說明", description: "模型回傳的證據綜整、適用範圍與限制，保留原文。" },
  related_checks: {
    label: "相關查核",
    description: "實際取得的 Cofacts 人工與 AI 查核回覆；空陣列表示本次沒有回傳相關查核。",
  },
  "related_checks[].type": {
    label: "查核來源類型",
    description:
      "cofacts_human：社群人工查核；cofacts_ai：AI 產生的回覆。來源類型不等同查核可信度。",
  },
  "related_checks[].text": { label: "查核內容", description: "此筆查核回覆的原文。" },
  "related_checks[].url": { label: "Cofacts 原文", description: "對應的 Cofacts 文章連結。" },
  "related_checks[].reference_url": {
    label: "主要引用來源",
    description: "此筆查核附帶的主要參考網址。",
  },
  "related_checks[].reference_urls": {
    label: "引用來源清單",
    description: "此筆查核附帶的參考網址，保留 API 回傳順序與重複項目。",
  },
  "related_checks[].classification": {
    label: "來源分類",
    description: "Cofacts 回覆的分類值，保留原始標記；與本次綜合判斷分開閱讀。",
  },
  "related_checks[].retrieval_score": {
    label: "搜尋排序分數",
    description:
      "Cofacts 搜尋召回的原始分數，只用於搜尋排序；不是百分比、機率、語意相關程度或真假分數。",
  },
  "related_checks[].relevance_score": {
    label: "語意相關程度",
    description: "0～1 的原始值，表示與待查主張的語意相關程度；不表示內容為真。",
  },
  meta: {
    label: "查核流程資訊",
    description: "本次請求的追蹤識別碼、候選與證據數量，以及流程警告。",
  },
  "meta.request_id": { label: "請求識別碼", description: "用於對照伺服器紀錄與回報問題。" },
  "meta.cofacts_candidates": {
    label: "召回候選數",
    description: "Cofacts 搜尋取得的候選文章數量。",
  },
  "meta.cofacts_relevant": {
    label: "通過相關性初篩數",
    description: "語意初篩後保留的文章數量，不代表這些文章的主張為真。",
  },
  "meta.cofacts_human_checks": {
    label: "人工證據數",
    description: "實際採用的 Cofacts 人工查核回覆數量。",
  },
  "meta.cofacts_ai_checks": { label: "AI 證據數", description: "實際採用的 Cofacts AI 回覆數量。" },
  "meta.url_context_used": {
    label: "是否使用網址背景",
    description: "true：已使用提供網址的文字作為背景；false：沒有使用。",
  },
  "meta.no_relevant_evidence": {
    label: "是否查無相關證據",
    description:
      "true：查無相關查核資料，判斷為模型常識推估，confidence 已下修至最高 0.5；false：有實際證據。",
  },
  "meta.cache": {
    label: "Worker 快取",
    description: "是否重用先前完整成功的查核；命中時保留原有證據與分數，本次不重跑模型。",
  },
  "meta.cache.status": {
    label: "快取狀態",
    description:
      "hit：命中快取；miss：未取得可用快取，重新查核；bypass：未使用快取服務。miss 不保證結果已成功寫入快取。",
  },
  "meta.cache.cached_at": {
    label: "快取建立時間",
    description: "這份查核結果存入快取的 UTC 時間；並非本次重新完成查核的時間。",
  },
  "meta.cache.expires_at": {
    label: "快取到期時間",
    description: "這份結果可重用的期限；快取也可能提早被移除，命中不會延長期限。",
  },
  "meta.warnings": {
    label: "流程警告",
    description: "可恢復的上游失敗；空陣列表示本次沒有回報流程警告。",
  },
  "meta.warnings[].stage": { label: "警告階段", description: "發生上游失敗的處理階段。" },
  "meta.warnings[].code": {
    label: "警告代碼",
    description: "UPSTREAM_UNAVAILABLE 表示該上游服務當時無法使用。",
  },
  "meta.warnings[].article_id": {
    label: "受影響文章",
    description: "發生問題的 Cofacts 文章識別碼；並非所有警告都有此欄位。",
  },
  error: {
    label: "錯誤代碼",
    description: "API 回傳的錯誤識別碼，用於區分輸入、來源限制或服務問題。",
  },
  message: { label: "錯誤說明", description: "API 回傳的錯誤原因與處理提示，保留原文。" },
  stage: { label: "失敗階段", description: "查核停止的處理階段。" },
  request_id: { label: "錯誤請求識別碼", description: "用於對照伺服器紀錄與回報問題。" },
};

const labels: Record<string, Record<string, string>> = {
  "meta.cache.status": { hit: "使用快取結果", miss: "本次重新查核", bypass: "未使用快取服務" },
  status: {
    completed: "流程完成",
    partial: "部分完成",
    blocked: "安全層停止查核",
    error: "請求失敗",
  },
  verdict: {
    supported: "證據支持",
    mostly_supported: "證據大致支持",
    mixed: "支持與反駁的證據並存",
    mostly_refuted: "證據大致反駁",
    refuted: "證據反駁",
    insufficient_evidence: "證據不足，無法判定",
  },
  "moderation.decision": { allow: "允許查核", review: "保留旗標並繼續", block: "停止查核" },
  "related_checks[].type": { cofacts_human: "社群人工查核", cofacts_ai: "AI 回覆" },
};
const stages: Record<string, string> = {
  moderation: "安全分類",
  "cofacts-search": "搜尋候選",
  relevance: "語意相關性初篩",
  "cofacts-evidence": "取得查核證據",
  url: "取得網址背景",
  synthesis: "證據綜整",
};

export function fieldInfo(path: string): FieldInfo {
  return Object.hasOwn(fields, path)
    ? fields[path]
    : { label: "額外欄位", description: "API 回傳的額外資料，依原始結構與值呈現。" };
}

export function valueLabel(path: string, value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const dictionary =
    path === "stage" || path === "meta.warnings[].stage"
      ? stages
      : Object.hasOwn(labels, path)
        ? labels[path]
        : undefined;
  return dictionary && Object.hasOwn(dictionary, value) ? dictionary[value] : undefined;
}

export function safeSourceLink(path: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !/(?:^|\.)(?:url|reference_url|reference_urls\[\])$/.test(path))
    return;
  try {
    const url = new URL(value);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return value;
  } catch {
    /* 無效網址仍以原文呈現。 */
  }
}
