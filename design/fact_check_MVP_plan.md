# Fact Check API — MVP 工程施工藍圖 v2

## 0. MVP 目標

* [ ] 使用 **Cloudflare Workers**
* [ ] 使用 **Hono**
* [ ] 建立：

  * [ ] `GET /api/fact-check?text={text}`
  * [ ] `GET /api/fact-check?text={text}&url={url}`
  * [ ] `POST /api/fact-check`
* [ ] MVP 唯一需要設定的 Secret：

  * [ ] `OPENROUTER_API_KEY`
* [ ] Cofacts GraphQL 不使用 app-id / app-secret
* [ ] Cloudflare Workers AI 使用：

  * [ ] `@cf/openai/gpt-oss-20b`：Cofacts 搜尋結果語意初篩／重排序
  * [ ] `@cf/google/gemma-4-26b-a4b-it`：最終證據綜整與查核判斷
* [ ] OpenRouter 使用：

  * [ ] `openai/gpt-oss-safeguard-20b`：內容安全分類

---

# 1. 核心設計原則

系統分成四個不同角色：

```text
Safeguard
= 這段內容能不能進入查核流程？

Cofacts
= 資料庫裡有哪些「可能相關」的既有訊息？

gpt-oss-20b
= Cofacts 找到的內容，哪些在語意上真的和待查主張有關？

Gemma 4 26B
= 綜合真正相關的查核證據後，這個主張可信程度如何？
```

* [ ] 不把 Cofacts `_score` 解讀成百分比
* [ ] 不把 Cofacts `_score` 直接轉成 factuality
* [ ] 不讓 `gpt-oss-20b` 判定真假
* [ ] `gpt-oss-20b` 在這個階段**只判斷相關性**
* [ ] 最終真假判斷只在 Evidence Synthesis 階段產生

---

# 2. 新版 Pipeline

```text
Client
  │
  ▼
Hono /api/fact-check
  │
  ▼
Input Validation
  │
  ▼
OpenRouter
gpt-oss-safeguard-20b
  │
  ├── block ───────────────────────► Response
  │
  └── allow / review
          │
          ├─────────────────────────────┐
          │                             │
          ▼                             ▼
   Cofacts 粗搜尋                    URL fetch
   moreLikeThis                     optional
   Top 10～20
          │                             │
          ▼                             │
 Cloudflare Workers AI                  │
 @cf/openai/gpt-oss-20b                 │
 語意 relevance filter / reranker       │
          │                             │
          ▼                             │
  Relevant Articles                     │
      Top 3～5                          │
          │                             │
          ▼                             │
 Cofacts 詳細查核資料                   │
 human replies / AI replies             │
          │                             │
          └──────────────┬──────────────┘
                         ▼
                   Evidence[]
                         │
                         ▼
               Cloudflare Workers AI
            @cf/google/gemma-4-26b-a4b-it
                         │
                         ▼
                  Final JSON
```

---

# 3. 為什麼 Cofacts 要拆成兩次 Query

不要第一個 GraphQL query 就把：

```text
articleReplies
aiReplies
references
hyperlinks
```

全部抓回來。

新版改成：

### Query A：Retrieval

目的：

> 找出一批可能相關文章。

只取：

```text
id
text
score
```

例如 Top 15。

↓

交給 `gpt-oss-20b`

↓

留下真正相關 Top 3～5。

↓

### Query B：Evidence Fetch

只針對通過初篩的 article：

```text
GetArticle(id)
```

取得：

```text
articleReplies
aiReplies
references
```

優點：

* [ ] 減少 Cofacts 不必要 payload
* [ ] 減少後續模型 context
* [ ] 避免大量無關 reply 進入 Gemma
* [ ] 將「搜尋」與「查核證據」兩個概念分開
* [ ] 每個階段比較容易測試與除錯

---

# 4. 專案初始化

## M0 — Hono Worker

* [ ] 建立 Cloudflare Workers project

```bash
npm create cloudflare@latest fact-check-api
cd fact-check-api
```

* [ ] 安裝 Hono

```bash
npm install hono
```

* [ ] 設定唯一 Secret：

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

---

# 5. Wrangler

```toml
name = "fact-check-api"
main = "src/index.ts"
compatibility_date = "2026-09-01"

[ai]
binding = "AI"
```

MVP 不需要：

```text
COFACTS_APP_ID
COFACTS_APP_SECRET
CLOUDFLARE_AI_API_KEY
```

因為：

* [ ] Cofacts 公開呼叫
* [ ] Workers AI 直接透過 `env.AI` binding 使用

---

# 6. 專案結構

```text
src/
├── index.ts
│
├── routes/
│   └── fact-check.ts
│
├── services/
│   ├── fact-check.ts
│   │
│   ├── moderation.ts
│   │
│   ├── cofacts-search.ts
│   ├── relevance-filter.ts
│   ├── cofacts-evidence.ts
│   │
│   ├── url-context.ts
│   └── synthesizer.ts
│
├── prompts/
│   ├── community-policy.ts
│   ├── relevance-filter.ts
│   └── fact-check.ts
│
├── schemas/
│   └── fact-check.ts
│
├── types/
│   ├── cofacts.ts
│   └── fact-check.ts
│
└── utils/
    └── url.ts
```

新版增加兩個重要 service：

```text
cofacts-search.ts
relevance-filter.ts
```

把搜尋與語意重排分開。

---

# 7. Health Check

* [ ] 建立：

```http
GET /health
```

回：

```json
{
  "status": "ok"
}
```

測試：

```bash
curl http://localhost:8787/health
```

---

# 8. API Input

## GET

```http
GET /api/fact-check?text={text}
```

或：

```http
GET /api/fact-check?text={text}&url={url}
```

## POST

```http
POST /api/fact-check
Content-Type: application/json
```

```json
{
  "text": "非學校型態學生，國中小以下目前沒有普遍補助",
  "url": "https://civic.vtaiwan.tw/issues/7"
}
```

* [ ] GET / POST 最後進入同一個 `factCheck()` service

---

# 9. Input Validation

* [ ] `text` 必填
* [ ] trim
* [ ] 空字串 → `400`
* [ ] 設定最大文字長度
* [ ] `url` optional
* [ ] URL 僅接受 HTTP / HTTPS

錯誤：

```json
{
  "status": "error",
  "error": "INVALID_INPUT",
  "message": "text is required"
}
```

---

# 10. M1 — Safety Gate

Service：

```text
src/services/moderation.ts
```

呼叫：

```http
POST https://openrouter.ai/api/v1/chat/completions
```

Model：

```text
openai/gpt-oss-safeguard-20b
```

Authorization：

```http
Authorization: Bearer ${OPENROUTER_API_KEY}
```

---

# 11. Safety Policy

至少處理：

* [ ] Hate / dehumanization
* [ ] Harassment / personal attack
* [ ] Explicit sexual content
* [ ] Violent threat
* [ ] Privacy exposure

但必須加入：

### Fact-check exception

以下不因原句本身敏感而直接 block：

* [ ] 引述待查核言論
* [ ] 新聞報導
* [ ] 公共政策討論
* [ ] 學術研究
* [ ] 批判性分析
* [ ] 詢問某項攻擊／仇恨敘述是否真實

輸出：

```ts
type ModerationResult = {
  decision: 'allow' | 'review' | 'block'
  categories: string[]
  reason?: string
}
```

---

# 12. Safety Gate 控制流程

```text
allow
→ 繼續

review
→ 繼續，但 response 保留 flag

block
→ 結束
```

* [ ] Safeguard upstream failure → `502`
* [ ] 不在 Safeguard failure 時偷偷跳過安全層

---

# 13. M2 — Cofacts Candidate Retrieval

Service：

```text
src/services/cofacts-search.ts
```

功能：

```ts
searchCofactsCandidates(text)
```

---

# 14. Cofacts 第一階段 Query

目前實測可直接：

```bash
curl -sS \
  -X POST \
  -H 'Content-Type: application/json' \
  'https://api.cofacts.tw/graphql' \
  --data-binary @- <<'JSON' | jq
{
  "query": "query Search($text: String!) { ListArticles(filter: { moreLikeThis: { like: $text, minimumShouldMatch: \"30%\" } }, orderBy: [{ _score: DESC }], first: 15) { totalCount edges { score node { id text } } } }",
  "variables": {
    "text": "非學校型態學生，國中小以下目前沒有普遍補助"
  }
}
JSON
```

注意這裡從：

```text
first: 5
```

調整成：

```text
first: 15
```

---

# 15. Candidate Retrieval 策略

預設：

```ts
COFACTS_CANDIDATE_LIMIT = 15
```

* [ ] 初期設定 15
* [ ] 未來依實測可調整成 10 / 20
* [ ] 不要因 `_score` 看似低而提前丟棄
* [ ] `_score` 只保留當 metadata

原因：

實測：

```text
最高 Cofacts _score
≠ 最相關文章
```

而真正很相關的文章可能出現在：

```text
第 3
第 4
第 5
甚至更後面
```

因此 retrieval 目標應偏向：

```text
Recall 優先
```

不是：

```text
Precision 優先
```

---

# 16. Candidate Type

```ts
type CofactsCandidate = {
  articleId: string
  text: string
  searchScore: number | null
}
```

注意欄位故意叫：

```text
searchScore
```

不要叫：

```text
similarity
relevance
confidence
percentage
```

避免工程上之後誤用。

---

# 17. M3 — 語意相關性初篩

新增：

```text
src/services/relevance-filter.ts
```

使用 Cloudflare Workers AI：

```text
@cf/openai/gpt-oss-20b
```

呼叫：

```ts
env.AI.run(
  '@cf/openai/gpt-oss-20b',
  {
    messages
  }
)
```

---

# 18. gpt-oss-20b 的任務必須非常窄

這個階段只回答：

> Cofacts 文章是否與使用者要查核的具體事實主張有關？

**禁止做真假判定。**

Prompt 核心：

```text
You are a semantic relevance filter for a fact-checking system.

Your ONLY task is to determine whether each candidate message
is substantively relevant to the factual claim.

Do NOT determine whether the claim is true or false.

Do NOT use the Cofacts search score as evidence of relevance.

A candidate is relevant only if it discusses the same factual
claim, an equivalent formulation of that claim, or evidence
directly needed to evaluate that claim.

Sharing a few keywords, entities, or broad topics is not enough.

For example:

Claim:
"國中小非學校型態實驗教育目前沒有普遍補助"

A message discussing "國中小性別教育"
is NOT relevant merely because both contain "國中小" and "教育".

Return structured JSON only.
```

---

# 19. Relevance Filter Output

每個 candidate：

```json
{
  "article_id": "3fygvjl81j6co",
  "relevant": true,
  "relevance": 0.96,
  "reason": "內容直接討論國中小自學生補助以及要求將高中自學補助向下延伸。"
}
```

另一筆：

```json
{
  "article_id": "AVqLDjRlyrDaTqlmmp7J",
  "relevant": false,
  "relevance": 0.03,
  "reason": "文章討論國中小性教育，與非學校型態實驗教育補助無關。"
}
```

---

# 20. Relevance Schema

```ts
type RelevanceResult = {
  articleId: string
  relevant: boolean
  relevance: number
  reason: string
}
```

其中：

```text
relevance
```

才定義成：

```text
0 ~ 1 的語意相關度
```

這與 Cofacts `_score` 是完全不同的東西。

---

# 21. Relevance Threshold

第一版先使用：

```ts
RELEVANCE_THRESHOLD = 0.65
```

* [ ] `>= 0.65` → 保留
* [ ] `< 0.65` → 排除
* [ ] 依 relevance 排序
* [ ] 最多保留 5 筆

例如：

```ts
const relevant = results
  .filter(x => x.relevant && x.relevance >= 0.65)
  .sort((a, b) => b.relevance - a.relevance)
  .slice(0, 5)
```

注意：

* [ ] `0.65` 是 MVP 初始值
* [ ] 之後必須用測試 dataset 校準
* [ ] 不宣稱 0.65 是客觀標準

---

# 22. 建議限制 Candidates 的文字長度

Cofacts 文章可能非常長。

送入 reranker 前：

* [ ] 保留 article ID
* [ ] 保留完整 text 的本地變數
* [ ] 模型輸入可先限制每篇約 2,000～4,000 字
* [ ] 最好不要直接把 15 篇無限長全文送入模型

例如：

```ts
const candidateForModel = {
  articleId,
  text: text.slice(0, 3000)
}
```

後續若發現截斷造成漏判，再調整。

---

# 23. Relevance Filter 必須批次處理

不要：

```text
15 篇文章
→ 呼叫模型 15 次
```

第一版直接：

```text
1 個 claim
+
15 個 candidate
↓
1 次 gpt-oss-20b
```

輸出：

```json
{
  "results": [
    {
      "article_id": "...",
      "relevant": false,
      "relevance": 0.04,
      "reason": "..."
    },
    {
      "article_id": "...",
      "relevant": true,
      "relevance": 0.95,
      "reason": "..."
    }
  ]
}
```

---

# 24. 初篩後沒有結果

如果：

```text
relevantCandidates.length === 0
```

不要視為 error。

代表：

```text
Cofacts 尚未找到足夠相關的既有內容
```

然後：

* [ ] `related_checks: []`
* [ ] 若有 URL → 仍交給 Gemma
* [ ] 若沒有 URL → Gemma 應高度傾向：

  * [ ] `insufficient_evidence`
  * [ ] low confidence

不能讓 Gemma 因為 Cofacts 沒資料就靠模型記憶自行查核。

---

# 25. M4 — Cofacts Evidence Fetch

只有經過 relevance filter 的文章才繼續。

建立：

```text
src/services/cofacts-evidence.ts
```

功能：

```ts
getCofactsEvidence(articleIds)
```

---

# 26. 第二階段 GraphQL Query

針對通過初篩的 article ID 查：

```graphql
query GetEvidence($id: String!) {
  GetArticle(id: $id) {
    id
    text

    references {
      type
      permalink
    }

    articleReplies(statuses: [NORMAL]) {
      replyType
      positiveFeedbackCount
      negativeFeedbackCount

      reply {
        id
        text
        type
        reference

        hyperlinks {
          url
          normalizedUrl
          title
        }
      }
    }

    aiReplies {
      status
      text
      createdAt
    }
  }
}
```

* [ ] 每個 relevant article 取得詳細 evidence
* [ ] 最多 3～5 篇
* [ ] 可用 `Promise.all()` 平行取得

---

# 27. Human / AI Evidence 必須分開

人工查核：

```text
cofacts-human
```

AI reply：

```text
cofacts-ai
```

不能混合。

Evidence priority：

```text
Human reply + source
        ↓
Cofacts AI reply
```

---

# 28. Evidence Normalizer

建立：

```ts
type Evidence = {
  source:
    | 'cofacts-human'
    | 'cofacts-ai'
    | 'provided-url'

  articleId?: string

  evidenceText: string

  verdict?:
    | 'supports'
    | 'refutes'
    | 'mixed'
    | 'opinion'
    | 'unknown'

  sourceUrl?: string
  cofactsUrl?: string

  retrievalScore?: number
  relevanceScore?: number

  positiveFeedback?: number
  negativeFeedback?: number

  reliability:
    | 'human-community'
    | 'ai-generated'
    | 'user-provided'
}
```

特別保留兩個不同欄位：

```text
retrievalScore
= Cofacts / Elasticsearch _score

relevanceScore
= gpt-oss-20b 語意初篩結果
```

絕不混用。

---

# 29. Cofacts Reply Type Mapping

MVP 可先：

```text
NOT_RUMOR
→ supports

RUMOR
→ refutes

OPINIONATED
→ opinion

NOT_ARTICLE
→ unknown
```

但：

* [ ] 只是 Evidence metadata
* [ ] 不是直接最終 verdict
* [ ] 不直接換算 factuality

---

# 30. Cofacts Article URL

產生：

```text
https://cofacts.tw/article/{ARTICLE_ID}
```

例如：

```text
https://cofacts.tw/article/3fygvjl81j6co
```

* [ ] 每筆 related check 都保留 Cofacts article URL

---

# 31. URL Context

URL optional。

有 URL 時：

```text
URL
↓
Safe Fetch
↓
HTML extraction
↓
provided-url evidence
```

* [ ] URL 不作為「可信來源」自動採信
* [ ] 只是使用者提供的 context

---

# 32. URL SSRF 防護

* [ ] 僅接受 HTTP / HTTPS
* [ ] 擋 localhost
* [ ] 擋 loopback
* [ ] 擋 private network
* [ ] 擋 link-local
* [ ] redirect 後重新檢查
* [ ] response size limit
* [ ] timeout
* [ ] content-type validation

---

# 33. URL 與 Cofacts 可以平行處理

Safety Gate 通過後：

```ts
const [candidates, urlContext] = await Promise.all([
  searchCofactsCandidates(text),
  url ? fetchUrlContext(url) : Promise.resolve(null)
])
```

接著：

```text
Candidates
↓
gpt-oss rerank
↓
Cofacts detailed evidence
```

URL fetch 不需要等 Cofacts 完成。

---

# 34. M5 — Gemma 最終 Evidence Synthesis

使用：

```text
@cf/google/gemma-4-26b-a4b-it
```

輸入：

```text
Original claim

Moderation status

Relevant Cofacts HUMAN evidence

Relevant Cofacts AI evidence

Provided URL evidence
```

---

# 35. Gemma 不得看到大量無關 Cofacts Candidate

非常重要。

錯誤流程：

```text
15 Cofacts candidates
↓
全部丟 Gemma
↓
叫 Gemma自己判斷哪些相關
```

新版：

```text
15 candidates
↓
gpt-oss-20b relevance filter
↓
3 relevant candidates
↓
取得 detailed evidence
↓
Gemma
```

Gemma 專心處理：

```text
Evidence synthesis
```

而不是同時負責：

```text
retrieval cleanup
+
fact checking
```

---

# 36. Gemma Prompt

核心：

```text
You are the final evidence synthesis stage of a fact-checking API.

Evaluate the factual claim primarily from the supplied evidence.

Do not treat model internal knowledge as evidence.

Do not assume a user-provided URL is trustworthy.

Cofacts retrievalScore represents search-engine ranking only.
It is NOT a probability and MUST NOT affect factuality directly.

relevanceScore only indicates whether an item is related to
the claim. It does NOT indicate whether that item is true.

Prioritize:

1. Human Cofacts fact-check replies with cited sources
2. Primary or authoritative sources contained in evidence
3. User-provided source context
4. Cofacts AI-generated replies

If the supplied evidence is insufficient, return
insufficient_evidence.

Return structured JSON only.
```

---

# 37. Final Verdict

```ts
type Verdict =
  | 'supported'
  | 'mostly_supported'
  | 'mixed'
  | 'mostly_refuted'
  | 'refuted'
  | 'insufficient_evidence'
```

---

# 38. factuality

```text
0.00
→ 強證據反駁

0.25
→ 大致不實

0.50
→ 混合／不確定

0.75
→ 大致支持

1.00
→ 強證據支持
```

---

# 39. confidence

另外輸出：

```text
0 ~ 1
```

表示：

> 系統對 factuality 判斷有多少充分、可靠且一致的證據。

因此：

```json
{
  "factuality": 0.9,
  "confidence": 0.2
}
```

和：

```json
{
  "factuality": 0.9,
  "confidence": 0.95
}
```

意義不同。

---

# 40. Final Response

```json
{
  "text": "非學校型態學生，國中小以下目前沒有普遍補助",

  "url": "https://civic.vtaiwan.tw/issues/7",

  "status": "completed",

  "moderation": {
    "decision": "allow",
    "categories": []
  },

  "factuality": 0.9,
  "confidence": 0.82,
  "verdict": "mostly_supported",

  "related_checks": [
    {
      "type": "cofacts_human",

      "text": "相關人工查核內容……",

      "url": "https://cofacts.tw/article/3fygvjl81j6co",

      "reference_url": "https://join.gov.tw/...",

      "classification": "NOT_RUMOR",

      "retrieval_score": 32.931576,

      "relevance_score": 0.97
    }
  ],

  "feedback": "目前找到的相關資料支持國中小非學校型態實驗教育並沒有比照高中階段提供普遍性的補助，但仍存在特定資格或地方性的補助措施，因此原敘述大致成立，但需要補充適用範圍。",

  "meta": {
    "cofacts_candidates": 15,
    "cofacts_relevant": 3,
    "cofacts_human_checks": 2,
    "cofacts_ai_checks": 1
  }
}
```

---

# 41. Orchestrator

```ts
async function factCheck(input: FactCheckInput) {

  // 1. Safety
  const moderation = await moderate(input.text)

  if (moderation.decision === 'block') {
    return blockedResponse(input, moderation)
  }

  // 2. Retrieval + URL context
  const [candidates, urlContext] = await Promise.all([
    searchCofactsCandidates(input.text),
    input.url
      ? fetchUrlContext(input.url)
      : Promise.resolve(null)
  ])

  // 3. Semantic relevance
  const relevantCandidates =
    await filterRelevantCandidates(
      input.text,
      candidates
    )

  // 4. Fetch detailed evidence only for relevant articles
  const cofactsEvidence =
    await getCofactsEvidence(
      relevantCandidates
    )

  // 5. Normalize
  const evidence = normalizeEvidence({
    cofactsEvidence,
    relevantCandidates,
    urlContext
  })

  // 6. Final synthesis
  return synthesize({
    ...input,
    moderation,
    evidence
  })
}
```

---

# 42. 新版模型職責表

| 階段        | 系統                                   | 任務                               |
| --------- | ------------------------------------ | -------------------------------- |
| Safety    | `gpt-oss-safeguard-20b` / OpenRouter | 是否允許進入處理                         |
| Retrieval | Cofacts `moreLikeThis`               | 大量召回可能相關文章                       |
| Reranking | `@cf/openai/gpt-oss-20b`             | 判斷文章是否真的與 claim 相關               |
| Evidence  | Cofacts replies                      | 提供既有人工／AI 查核                     |
| Synthesis | Gemma 4 26B                          | 判斷 factuality、confidence、verdict |

---

# 43. Failure Strategy

## Safeguard fail

* [ ] 回 `502`
* [ ] 不跳過 Safety Gate

## Cofacts Search fail

* [ ] URL 有資料 → 可以繼續
* [ ] response 標記 upstream unavailable

## Cofacts Search = 0

* [ ] 不是錯誤
* [ ] `related_checks: []`

## gpt-oss relevance filter fail

* [ ] 不直接把未過濾 Cofacts candidates 送 Gemma
* [ ] 建議回 partial / upstream error
* [ ] 避免重新引入 retrieval noise

## Cofacts Detail fail

* [ ] 跳過單筆失敗 article
* [ ] 其他 evidence 照常處理

## URL fetch fail

* [ ] Cofacts 流程照常

## Gemma fail

* [ ] 回 `502`
* [ ] 不自行拼 factuality

---

# 44. Logging

Production 前至少紀錄：

```text
request id
text length
URL exists / not exists

moderation result

Cofacts candidate count

Cofacts candidate IDs
Cofacts retrieval scores

reranker relevance scores
selected article IDs

human evidence count
AI evidence count

final verdict
final factuality
final confidence

latency of each stage
```

但：

* [ ] production log 不應長期保存完整使用者 text
* [ ] 不記錄 OpenRouter key
* [ ] 不記錄完整敏感內容

---

# 45. 初步測試 Dataset

建立：

```text
tests/fixtures/relevance-cases.json
```

把你這次實測直接納入 regression test。

例如：

```json
{
  "claim": "非學校型態學生，國中小以下目前沒有普遍補助",

  "candidates": [
    {
      "id": "AVqLDjRlyrDaTqlmmp7J",
      "expected": false,
      "reason": "討論國中小性教育"
    },

    {
      "id": "3el110m0jufh2",
      "expected": false,
      "reason": "討論高雄停班停課"
    },

    {
      "id": "3vuve0stdu54e",
      "expected": false,
      "reason": "討論同志教育與公投"
    },

    {
      "id": "3fygvjl81j6co",
      "expected": true,
      "reason": "直接討論國中小自學學生補助"
    }
  ]
}
```

這組非常適合當第一個 reranker regression test。

---

# 46. Reranker 驗收標準

以上述案例：

```text
AVqLDjRlyrDaTqlmmp7J
→ irrelevant

3el110m0jufh2
→ irrelevant

3vuve0stdu54e
→ irrelevant

3fygvjl81j6co
→ relevant
```

* [ ] 每次 prompt 或模型調整後跑 regression test
* [ ] 避免修改 prompt 後反而退化

---

# 47. 成本控制

`gpt-oss-20b` 用在 reranking 時：

* [ ] 一次批次判斷 10～20 candidates
* [ ] 不逐篇 call
* [ ] 限制 candidate text 長度
* [ ] temperature 儘量低
* [ ] 要求精簡 JSON
* [ ] 不要求模型進行長篇 reasoning output

如此新增 reranker 的成本與 latency 都能控制。

---

# 48. 可選的下一階段優化

MVP 完成後才考慮：

* [ ] Cache 相同 claim
* [ ] Rate limiting
* [ ] Claim extraction
* [ ] 一段文字拆成多個 factual claims
* [ ] 多 query retrieval
* [ ] 同義詞／關鍵字補充搜尋
* [ ] Cofacts query fusion
* [ ] Search + semantic rerank ensemble
* [ ] D1 保存匿名化的測試結果
* [ ] 建立人工標註 relevance dataset
* [ ] 校準 relevance threshold
* [ ] 校準 factuality / confidence

MVP 不先做。

---

# 49. 新版施工順序

## Phase 1 — Skeleton

* [ ] Hono
* [ ] Worker
* [ ] `/health`
* [ ] Workers AI binding

## Phase 2 — Safety

* [ ] OpenRouter
* [ ] `gpt-oss-safeguard-20b`
* [ ] allow / review / block

## Phase 3 — Cofacts Retrieval

* [ ] `moreLikeThis`
* [ ] `first: 15`
* [ ] 只取得 `id / text / score`

## Phase 4 — Semantic Reranker

* [ ] `@cf/openai/gpt-oss-20b`
* [ ] batch candidates
* [ ] relevant boolean
* [ ] relevance `0~1`
* [ ] reason
* [ ] threshold
* [ ] top 3～5

## Phase 5 — Cofacts Evidence

* [ ] `GetArticle`
* [ ] human replies
* [ ] reply types
* [ ] feedback
* [ ] references
* [ ] AI replies

## Phase 6 — Evidence Normalization

* [ ] human / AI 分流
* [ ] retrievalScore
* [ ] relevanceScore
* [ ] source URLs

## Phase 7 — Gemma

* [ ] factuality
* [ ] confidence
* [ ] verdict
* [ ] feedback

到這裡：

```http
GET /api/fact-check?text=...
```

已經是完整 MVP。

## Phase 8 — URL

* [ ] URL fetch
* [ ] SSRF
* [ ] extraction
* [ ] provided-url evidence

## Phase 9 — Hardening

* [ ] logging
* [ ] timeout
* [ ] error handling
* [ ] cache
* [ ] rate limit
* [ ] tests

---

# 50. MVP Definition of Done

* [ ] Hono API 可正常部署
* [ ] 唯一 Secret 是 `OPENROUTER_API_KEY`
* [ ] Safeguard 正常
* [ ] Cofacts 公開 GraphQL 正常
* [ ] `moreLikeThis` 可取得候選內容
* [ ] 不把 Cofacts `_score` 當百分比
* [ ] Cofacts 初步取至少約 10～20 candidates
* [ ] `gpt-oss-20b` 可排除語意無關候選
* [ ] reranker 不負責真假判定
* [ ] 只對 relevant candidates 取得 detailed replies
* [ ] Human reply 與 AI reply 分開
* [ ] Gemma 只收到已整理好的 evidence
* [ ] factuality / confidence 分離
* [ ] 能輸出 fixed verdict enum
* [ ] related_checks 有原始來源
* [ ] 有 URL 時可以安全抓取
* [ ] upstream failure 有明確 fallback
* [ ] 你這次 Cofacts 實測案例成為 automated regression test
* [ ] End-to-end 測試成功

---

# 51. 最終 MVP 架構

```text
                     ┌────────────────────┐
                     │   User claim       │
                     └─────────┬──────────┘
                               │
                               ▼
                     Safeguard 20B
                       OpenRouter
                               │
                               ▼
                    Cofacts moreLikeThis
                       Top ~15 recall
                               │
                               ▼
                    gpt-oss-20b
                  semantic relevance
                       Workers AI
                               │
                     ┌─────────┴─────────┐
                     │                   │
                irrelevant           relevant
                  discard               │
                                        ▼
                              Cofacts detailed
                                 evidence
                                        │
                                        ├──── Human replies
                                        │
                                        └──── AI replies
                                        │
                           URL ──────────┤
                                        ▼
                                  Evidence[]
                                        │
                                        ▼
                                Gemma 4 26B
                                        │
                                        ▼
                       factuality / confidence
                         verdict / feedback
```
