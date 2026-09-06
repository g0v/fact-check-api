# 查核 API 維護指南

本目錄實作 [工程藍圖](../../design/fact_check_MVP_plan.md) 與 [議題 #5](https://github.com/g0v/fact-check-api/issues/5)。主程式只負責掛載 API 與 `/health`，Vue SSR 保持獨立。

## 閱讀順序

1. `index.ts`：request ID、禁止快取、統一錯誤回應。
2. `routes/fact-check.ts`：GET／POST 共用輸入驗證及 `factCheck()`。
3. `services/fact-check.ts`：完整流程、平行工作與部分失敗策略。
4. `services/`：安全分類、候選搜尋、批次初篩、詳細證據、URL 背景、Gemma 綜整。
5. `prompts/`、`schemas/`、`types/`：模型職責、輸入輸出契約與資料型別。
6. `config.ts`：模型名稱、門檻、文字及時間限制。

## 已確認的 MVP 契約

- `text` trim 後必填，最多 10,000 個 Unicode code point；URL 最長 2,048 個 UTF-16 code unit。
- POST 必須為 JSON；body 最多 128,000 bytes。URL 選填，拒絕空字串、非 HTTP／HTTPS、內網位址及帶帳號密碼的網址。
- `allow`／`review` 繼續，`review` 留在 moderation 中；`block` 回 HTTP 200、`status: blocked`，分數與 verdict 為 `null`，不執行下游。
- 正常回 HTTP 200、`status: completed`；有可恢復的上游失敗則回 HTTP 200、`status: partial`，原因在 `meta.warnings`。
- 每次回應有 `X-Request-Id` 與 `Cache-Control: no-store`。API 錯誤含繁體中文 message、固定英文 error code 與 request ID。

| 失敗階段                  | 行為                                                            |
| ------------------------- | --------------------------------------------------------------- |
| Safeguard                 | HTTP 502，不略過安全層                                          |
| Cofacts search／relevance | 已成功抓到 URL 文字才以 URL 繼續並標記 partial，否則 HTTP 502   |
| Cofacts detail            | 單筆文章失敗跳過，記錄文章 ID，其他證據繼續                     |
| URL                       | 保留警告，Cofacts 照常；搜尋成功但沒有證據時交 Gemma 回證據不足 |
| Gemma／模型 JSON 驗證     | HTTP 502，不自行生成替代分數                                    |

## 證據契約

候選搜尋預設取 15 筆，只查 `id`、`text`、`score`；保留 `searchScore`，不依此篩掉文章。初篩一次呼叫 `gpt-oss-20b`，每篇送入最多 3,000 個 UTF-16 code unit，不附搜尋分數。輸出必須涵蓋所有候選 ID，且不得新增或重複。只有 `relevant: true` 且 `relevance >= 0.65` 才保留，依相關性排序、最多 5 篇。

詳細資料以文章為單位平行取得。人工與 AI 回覆分別標記 `cofacts-human`／`cofacts-ai`，每篇各最多 10 則，AI 只取 `SUCCESS`。`retrievalScore` 與 `relevanceScore` 分開保存。人工 reply 的 `reference`、hyperlinks 與原始文章的 references 分開；原始訊息出處不會充當人工查核引文。

每筆 evidence 文字最多 6,000 個 UTF-16 code unit。綜整時另分配全體 evidence 共 60,000 的本文文字預算，以及各半的原始文章與引文文字預算，避免過量回覆超出 context。`related_checks` 由程式根據實際 Cofacts 證據建立，不由模型編造；每筆保留 Cofacts article URL。

Gemma 為唯一真假判斷階段。當 evidence 空陣列時，模型必須回 `insufficient_evidence`、`factuality: 0.5`、`confidence <= 0.2`；違反便回上游錯誤。這裡的 0.5 表示未能判定，不是「有一半機率為真」。各門檻仍須以真實 dataset 校準。

## URL 抓取邊界

每次目標抓取前檢查 URL 與公開 DNS 的 A／AAAA 結果；只要包含非公開位址便拒絕。使用 Cloudflare 公開 DNS-over-HTTPS，不需要額外 secret。手動處理最多 3 次 redirect，逐次重新驗證。DNS 與整個抓取／讀取流程共用 10 秒期限，body 最多 1 MB；支援 UTF-8／ASCII 的 `text/html`、`text/plain`，拒絕明示的其他編碼。

HTML 使用 Workers 原生 `HTMLRewriter` 移除腳本、樣式、樣板等內容，再解碼 HTML entities、擷取最多 12,000 個 UTF-16 code unit。網站需要 JavaScript 才產生的內容不會被執行。來源只標為 `user-provided`，不自動視為可信。

DNS 預檢與 Workers `fetch()` 是兩次解析，無法在一般 Worker fetch 中釘選任意目標 IP；DNS rebinding 的最終隔離依賴 Cloudflare 執行環境。此 fetcher 不能直接移到可存取私網的 Node 伺服器；若要部署於該環境，需改用能固定連線 IP 的出口代理。模型 binding timeout 會停止等待，但 Workers AI API 沒有在本介面提供取消推論的方法，已送出的推論仍可能計費。

## 驗證

```bash
vp run check
vp run build
vp test
vp run typecheck
```

一般測試用假的 OpenRouter／Cofacts／Workers AI 傳輸，覆蓋完整 Hono pipeline、安全 gate、門檻、錯誤 fallback、分數分離與 SSRF 邊界。HTML extraction 另外以真正的本機 workerd 執行，使用 `workerd test` 直接呼叫測試 handler，不開啟本機 HTTP socket。

`tests/fixtures/relevance-cases.json` 保存藍圖的四個 ID 與標註；一般回歸測試只驗證模型輸出的處理邏輯，不代表模型已通過語意驗收。真實回歸會取得原文，並透過 Workers AI remote binding 呼叫模型：

```bash
FACT_CHECK_LIVE=1 vp test tests/relevance.live.test.ts
```

此指令需要網路與已登入 Cloudflare，會使用 Workers AI 額度；不使用 OpenRouter key，也不讀本機 `.dev.vars`。完整正式服務驗收則需自行設定唯一 secret `OPENROUTER_API_KEY`，啟動 `vp run dev` 後，以 README 的 GET／POST 範例查核。

## 建置與紀錄

Vite build 禁用環境檔讀取，並清除僅供 preview 複製 secret 使用的外掛 `configPath`；產物不包含本機 secret。本機開發仍由 Cloudflare 外掛在執行期載入 `.dev.vars`。

程式 log 只包含 request ID、文字長度、有無 URL、安全決策、候選 ID、搜尋／相關性分數、證據數量、最終判斷及階段時間，不紀錄使用者原文、完整 URL、上游錯誤 body 或 credential。Cloudflare 平台的請求紀錄由平台設定控制；敏感查核內容建議使用 POST，以免出現在網址歷史或 access log。

## 核對來源

- [Cofacts Article schema](https://github.com/cofacts/rumors-api/blob/master/src/graphql/models/Article.js)
- [Cofacts AIResponse schema](https://github.com/cofacts/rumors-api/blob/master/src/graphql/models/AIResponse.js)
- [gpt-oss-20b binding](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [Gemma binding 與 chat completion 輸出](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)
- [Cloudflare Vite secret 複製行為](https://developers.cloudflare.com/workers/vite-plugin/reference/secrets/)
