# 查核 API 維護指南

本目錄實作 [工程藍圖](../../design/fact_check_MVP_plan.md) 與 [議題 #5](https://github.com/g0v/fact-check-api/issues/5)。主程式只負責掛載 API 與 `/health`，Vue SSR 保持獨立。

## 閱讀順序

1. `index.ts`：request ID、禁止瀏覽器快取、統一錯誤回應。
2. `routes/fact-check.ts`：GET／POST 共用輸入驗證及 `cachedFactCheck()`；`middleware/same-origin.ts` 在讀取 POST 本文前檢查 Origin。
3. `services/fact-check.ts`：完整流程、平行工作與部分失敗策略。
4. `services/`：安全分類、候選搜尋、批次初篩、詳細證據、URL 背景、Gemma 綜整。
5. `prompts/`、`schemas/`、`types/`：模型職責、輸入輸出契約與資料型別。
6. `config.ts`：模型名稱、門檻、文字及時間限制、每日 Workers AI 用量上限與 neurons 換算。
7. `services/usage-budget.ts`、`utils/usage.ts`：Durable Object 記帳、用量估算與 token 用量紀錄。

## 同 IP 流量限制

`routes/fact-check.ts` 在輸入驗證與查核流程前，對 `/fact-check` 的 GET／POST 掛載 `middleware/rate-limit.ts` 的 `ipRateLimit`。限流 key 取自 `cf-connecting-ip`：IPv4 使用完整 IP；IPv6 正規化並收斂至 `/64` 前綴，避免同一網段輪換位址繞過額度。若沒有 `cf-connecting-ip`（例如本機 Wrangler dev 或 Node 測試），直接放行，不猜測或代用其他標頭。

middleware 依序檢查兩層：Cloudflare 內建 `RATE_LIMITER` binding 以每個 per-PoP key 每 10 秒 30 次擋洪水，再由 `RATE_LIMIT_DO` Durable Object 以每個 key 記錄上次通過時間，預設冷卻 3 秒。任一 binding 未提供或檢查失敗時，該層採放行策略，避免限流服務故障誤擋正常請求。

任一層拒絕時拋出 `ApiError`，回 HTTP 429、`error: "RATE_LIMITED"` 及 `Retry-After` header。冷卻毫秒數由 `config.ts` 的 `RATE_LIMIT.windowMs`（對應 `wrangler.jsonc` 的 `RATE_LIMIT_WINDOW_MS`，預設 3000）傳給 Durable Object；調整變數即可調整同 IP 間隔。

## 已確認的 MVP 契約

- `text` trim 後必填，最多 10,000 個 Unicode code point；URL 最長 2,048 個 UTF-16 code unit。
- POST 的 Origin 必須與請求 URL 的 origin 完全一致；跨來源、缺少 Origin 或 `Origin: null` 回 HTTP 403／`FORBIDDEN_ORIGIN`，不呼叫上游。此端點的 OPTIONS 也回 403，不提供跨來源 CORS 授權。
- POST 必須為 JSON；body 最多 128,000 bytes。URL 選填，拒絕空字串、非 HTTP／HTTPS、內網位址及帶帳號密碼的網址。
- `allow`／`review` 繼續，`review` 留在 moderation 中；`block` 回 HTTP 200、`status: blocked`，分數與 verdict 為 `null`，不執行下游。分類代碼非空時不得為 `allow`：模型若回 `allow` 且列出任何分類，`parseModeration()` 會改判為 `block`；`review` 帶分類仍屬查核例外，繼續查核。
- Safeguard 服務失敗（傳輸、逾時、HTTP 錯誤或輸出格式錯誤）時跳過安全分類：`moderation.decision` 由程式標記為 `skipped`、`meta.warnings` 加入 `moderation`，以 `partial` 繼續查核；缺少金鑰的設定錯誤仍回 HTTP 502。`skipped` 不接受來自模型輸出或快取。
- 正常回 HTTP 200、`status: completed`；有可恢復的上游失敗則回 HTTP 200、`status: partial`，原因在 `meta.warnings`。
- 每次回應有 `X-Request-Id` 與 `Cache-Control: no-store`。API 錯誤含繁體中文 message、固定英文 error code 與 request ID。

| 失敗階段                  | 行為                                                         |
| ------------------------- | ------------------------------------------------------------ |
| Safeguard                 | 跳過安全分類並標記 `skipped` 與警告；設定錯誤仍回 HTTP 502   |
| Cofacts search／relevance | 一律 HTTP 502，不因已抓到 URL 文字而繼續                     |
| Cofacts detail            | 單筆文章失敗跳過，記錄文章 ID，其他證據繼續                  |
| URL                       | 保留警告，Cofacts 照常；查無 Cofacts 證據時交 Gemma 常識判斷 |
| Gemma／模型 JSON 驗證     | HTTP 502，不自行生成替代分數                                 |

## Safeguard 呼叫契約

`cachedFactCheck()` 未命中時才執行以下完整查核流程；有效快取沿用當時的安全分類與證據結果。

`services/moderation.ts` 參考 `civic-talk-hono/src/moderation/service.ts` 已實測的 OpenRouter 寫法，使用 `response_format.type: "json_schema"`、`strict: true`、`reasoning: { effort: "low" }`、`max_tokens: 1600` 與 `temperature: 0`。推理 token 也會占用輸出額度；不可只調整 `max_tokens` 而忽略推理設定。

Schema 使用查核 API 的 `decision`（`allow`／`review`／`block`）、`categories`、`reason`；分類政策保留查核例外，真假判定由後續 Gemma 負責。`parseModeration()` 為安全決策的唯一來源：`allow` 僅在 `categories` 為空時成立，帶分類的 `allow` 一律由程式改判 `block`（`review` 帶分類不改判）。只接受無 choice error、`finish_reason: "stop"` 且 `message.content` 為有效判定 JSON 的回應；截斷、缺少完成標記或格式錯誤一律視為安全層失敗，跳過安全分類並以 `skipped` 標記 partial 繼續查核，不以不完整輸出替代判定。

`tests/moderation.test.ts` 固定驗證請求參數與異常回應處理；使用模擬傳輸，不代表 fact-check-api 已通過真實模型實測。

### Safeguard 除錯紀錄

查核 API 預設透過 `console.info` 輸出結構化 JSON，不需另外開啟 debug 設定。用同一個 `request_id` 依序查看：

1. `request.openrouter_api_key_present`：`factCheck` 收到的 Worker binding 是否有設定值。
2. `moderation_config`：`step: "before_read"` 在讀取 binding 前輸出；`step: "after_read"` 記錄 `api_key_present`、`api_key_is_string` 與 `api_key_configured`。最後一項須為非空白字串才為 `true`；這不代表金鑰已通過 OpenRouter 驗證。
3. `moderation_request`：設定檢查通過，準備送出；包含模型名稱、timeout 與推理／輸出參數。
4. `moderation_http_response`：已收到上游 headers，包含 `upstream_status` 與當時耗時。
5. `moderation_response`：已解析上游 JSON，包含 choice 數量、`finish_reason`、content 長度、有無推理、數值錯誤碼與 token 用量。缺少或無效的數值記為 `null`；未知完成代碼記為 `unknown`。
6. `moderation_error`：失敗原因與可用的診斷欄位；原有 `stage` 紀錄仍保留。對外行為：缺少金鑰回 HTTP 502，其餘失敗跳過安全分類並以 `skipped`／`partial` 繼續。

| `moderation_error.reason`                                                             | 排查方向                                                                                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `missing_api_key`                                                                     | Worker binding 缺少、不是字串或只有空白；請確認目前執行環境的 `OPENROUTER_API_KEY` 設定。                       |
| `network_error`／`timeout`                                                            | 請求參數、連線失敗或超過期限；`upstream_status: null` 表示尚未收到 HTTP 回應，已有狀態則可能卡在讀取本文。      |
| `http_error`                                                                          | OpenRouter 回非成功狀態；查看 `upstream_status`，例如 401、429 或 5xx。                                         |
| `response_read_error`／`response_too_large`／`invalid_response_json`                  | HTTP 回應本文讀取、大小限制或外層 JSON 格式問題。                                                               |
| `upstream_error`／`choice_error`                                                      | HTTP 成功但回應含錯誤物件；查看 `upstream_error_code`／`choice_error_code`。                                    |
| `incomplete_completion`                                                               | `finish_reason` 缺少或不是 `stop`；若為 `length`，搭配 `completion_tokens` 與 `reasoning_tokens` 檢查輸出額度。 |
| `invalid_completion`／`invalid_content`／`invalid_content_json`／`invalid_moderation` | 分別是 completion 結構、content 空白／型別／長度、content JSON 或判定 schema 問題。                             |

例如讀取後出現 `api_key_present: false`、`api_key_configured: false`，接著出現 `reason: "missing_api_key"`，代表尚未呼叫 OpenRouter。若已出現 `moderation_request`，則繼續查看 HTTP 狀態與回應診斷。僅憑舊紀錄的 1 ms 失敗尚不能判定金鑰是否缺少。

本機 `vp run dev` 由 Cloudflare 外掛交給 Wrangler 載入與 `wrangler.jsonc` 同目錄的 `.dev.vars`；Vite 的 `envDir: false` 不會停用這條載入路徑。若啟動後才建立 `.dev.vars`，請先儲存檔案，完全停止並重新執行 `vp run dev`，再確認 `api_key_configured`。目前安裝的外掛只針對設定檔的 `change` 事件重新啟動，新增檔案不一定觸發載入。若使用 `CLOUDFLARE_ENV`，也須確認對應 `.dev.vars.<環境名稱>` 是否覆蓋一般設定。

上述紀錄只包含固定訊息、布林值、數值與允許的完成代碼，不記錄金鑰值或長度、headers、使用者原文、模型 content／reasoning、上游錯誤訊息或本文。`tests/moderation-logging.test.ts` 覆蓋設定缺少、傳輸失敗、輸出驗證與紀錄隱私。

Workers 的 `fetch` 不支援 `redirect: "error"`，使用時會在連線前拋出 `TypeError`，也可能呈現為幾毫秒內的 `network_error`。共用 JSON 請求與 DNS 查詢使用 `redirect: "manual"`，再透過 `response.ok` 拒絕重新導向等非成功狀態；不自動將授權標頭送往重新導向目標。

## Worker 查核結果快取

`services/cached-fact-check.ts` 實作 [議題 #7](https://github.com/g0v/fact-check-api/issues/7)，在輸入與 Origin 驗證後、整個 pipeline 之前查詢 `caches.open("fact-check-results")`。命中時不呼叫 Safeguard、Cofacts 或 Workers AI；只有先前 `completed`、無警告且結構有效的結果可被採用。

- 預設 TTL 為 3,600 秒，另在 payload 檢查建立時間，逾期、未來時間或格式錯誤視為不可用；命中不延長期限。
- 合成 GET key 使用目前站台 origin 與 SHA-256，摘要輸入包含正規化後的 `text`、`url`、`MODELS`、`LIMITS`、三份提示及 `RESULT_CACHE.version`。GET／POST 共用，文字內部空白、標點與字形不合併。
- 模型、提示及門檻變更自動產生新 key；其他查核邏輯、輸出參數或回應契約改動時應遞增 `RESULT_CACHE.version`，避免沿用舊結果。金鑰不參與 key，不需為金鑰輪替清快取。
- 儲存內容含查核證據與綜整結果，但移除輸入回填欄位、原 request ID 與快取 metadata；命中時回填本次輸入及新的 request ID。此機制仍會在 Worker 端保留查核結果至 TTL 到期或被提早移除。
- 只有內部快取用的 Response 帶 `public, max-age=3600`。對外回應持續 `Cache-Control: no-store`，不提供讀取合成快取 URL 的公開路由。
- Worker 使用 `executionCtx.waitUntil()` 承接寫入。開啟、讀取與寫入各有 1 秒等待上限；任何快取問題不改變查核結果、不新增 `meta.warnings`，也不回傳快取例外文字。
- JSON 儲存與讀取上限沿用 `LIMITS.upstreamBytes`；過大的結果只略過快取。沒有 Cache API 的 Node 測試環境直接執行原 pipeline。
- 不做跨請求的鎖定或相同進行中請求合併；同時出現的冷快取請求可能各自呼叫模型。背景寫入尚未完成時重送亦可能 miss。

成功回應含 `X-Fact-Check-Cache: HIT/MISS/BYPASS` 與 `meta.cache.status`。命中另含 `cached_at`／`expires_at`，首頁逐項說明這些欄位；原始證據與分數不重新計算。Log 只新增 `event: "cache"`、request ID、操作（`read`／`write`／`schedule`）與狀態，不輸出 hash、原文、網址或 credential。`stored` 表示 Cache API 的寫入呼叫已完成，不保證平台一定保留到期。

[Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) 的內容不跨資料中心複寫，平台可能提早移除；Dashboard／Playground 預覽不保證可觀察命中。`tests/result-cache.test.ts` 覆蓋命中、過期、隔離、故障回退、背景寫入與同源限制；使用模擬儲存，不代表已部署驗收。

## 每日 Workers AI 用量上限

`services/usage-budget.ts` 實作 [議題 #9](https://github.com/g0v/fact-check-api/issues/9)。`cachedFactCheck()` 未命中快取後、呼叫任何模型前，向名為 `global` 的單一 `UsageBudget` Durable Object 送出 `reserve`；查核結束（含封鎖與失敗）後以 `settle` 修正為實際用量，並用 `waitUntil()` 承接。

- 帳本以 UTC 日為區間（`Math.floor(Date.now() / 86_400_000)`），與 Workers AI 免費額度同時歸零；`settle` 帶回預留時的區間，跨日的差額不追溯也不抵扣新區間。
- 單位是 Workers AI 的 neurons，只計 `relevance` 與 `synthesis` 兩段；`moderation` 走 OpenRouter，`usageNeurons()` 固定回 0，但 token 數仍記錄在 `usage` log。
- 上限由 `DAILY_NEURON_BUDGET` 變數決定（字串或數字），無效或缺少時採用 `BUDGET.dailyNeurons`（10,000，等於免費額度）；上限為 0 時一律拒絕。上限由 Worker 傳給 Durable Object，物件本身只負責累加與判斷。
- 預留用量由 `estimateRequestNeurons()` 依輸入長度加上 `BUDGET.typicalTokens` 的典型候選與證據量估算，典型查核約 300 neurons；不用最壞情況估算，避免額度尚有剩餘卻被拒絕。
- 各模型服務在上游回應後立即呼叫 `UsageRecorder`：優先讀取 `usage.prompt_tokens`／`completion_tokens` 或 `input_tokens`／`output_tokens`，缺少時以 `BUDGET.charsPerToken` 由送出訊息與整份回應長度估算並標記 `estimated`。逾時或傳輸失敗沒有回應時不記錄。
- neurons 依 `BUDGET.neuronsPerMillionTokens`（Workers AI 定價頁公告值）換算。`BUDGET` 不參與結果快取鍵，調整上限或換算值不會使快取失效。
- 免費額度以 Cloudflare 帳號為單位，帳本只看得到本服務的用量；同帳號其他 Workers AI 呼叫需另行調低上限。
- Durable Object 使用 SQLite 儲存後端（Free 方案要求），`state.storage` 的 KV 介面仍可使用；程式不匯入 `cloudflare:workers`，binding 與 state 只用最小型別描述。
- `reserve` 失敗或逾時（2 秒）時回 HTTP 503／`BUDGET_UNAVAILABLE`，寧可暫停查核也不放行未計量的模型呼叫；`settle` 失敗只記錄。沒有 `USAGE_BUDGET` binding（Node 單元測試）時略過控管。

Log 新增 `event: "usage"`（各階段的模型、token 數、是否估算與 neurons）與 `event: "budget"`（操作、狀態、預留與累計 neurons、重設時間、當日的通過與拒絕次數），不含原文、模型輸出或 credential。`tests/usage-budget.test.ts` 覆蓋帳本、Durable Object 指令、估算、流程整合與失敗策略；`tests/usage-budget-worker.test.ts` 在 workerd 以真實 Durable Object binding 驗證預留、結算與拒絕。

## 瀏覽器來源限制

同源依請求 URL 的協定、主機與連接埠判斷，適用部署網域及本機開發，不新增 secret 或白名單設定。不使用 Referer、Host、X-Forwarded-Host 等標頭替代 Origin，也不允許 `Origin: null`。標準 Origin 不含路徑或尾端斜線。

本站前端以相對 URL 執行 POST fetch，Origin 由瀏覽器設定；不要把金鑰放到前端。CLI 維護測試可明確提供同源 Origin，範例見 README。此限制不驗證呼叫者身分，不能防止非瀏覽器程式自行設定 Origin；GET 保持原有公開行為。

## 證據契約

候選搜尋預設取 15 筆，只查 `id`、`text`、`score`；保留 `searchScore`，不依此篩掉文章。初篩一次呼叫 `gpt-oss-20b`，每篇送入最多 3,000 個 UTF-16 code unit，不附搜尋分數。輸出必須涵蓋所有候選 ID，且不得新增或重複。只有 `relevant: true` 且 `relevance >= 0.65` 才保留，依相關性排序、最多 5 篇。

若首頁的「通過相關性初篩數」一直是 1，先查看 `meta.cache.status`：`hit` 代表沿用先前結果，不會重新初篩。未命中快取時，可用相同 request ID 的 `relevance` log 排查：`candidate_count` 是候選數；`article_ids`、`relevant_flags`、`relevance_scores` 按相同索引對應每篇文章；`relevance_threshold` 與 `selection_limit` 是分數門檻與保留上限；`selected_count` 及 `selected_article_ids` 是實際採用結果。此數字以文章計算，一篇文章可以提供多則查核回覆。診斷不記錄文章內容或模型的自由文字理由。

若每篇相關性分數都相同，可進一步對照兩個紀錄點：`relevance_model_request` 的 `distinct_text_count` 是截斷後送入模型的不同本文數量，`source_text_lengths` 與 `sent_text_lengths` 顯示截斷前後的 UTF-16 長度；`relevance_model_response` 的 `model_relevance_scores` 是模型 JSON 剛解析後、尚未依 ID 對應或套用門檻排序的數值，非數值以 `null` 記錄後仍會驗證失敗。各紀錄的 `article_ids` 與分數依相同索引對應，但模型可以改變文章順序，跨紀錄應以 ID 比對。若此處已全部同分，應追查模型輸入及輸出；不能單憑同分推定為並發污染。初篩只呼叫一次模型並等待結果，各請求使用獨立的區域陣列與 Map。`tests/relevance-isolation.test.ts` 驗證十五筆不同分數、亂序回應及同時請求反序完成的隔離行為。命中結果快取時不會產生這些模型紀錄；診斷修改本身不會使既有快取失效。

詳細資料以文章為單位平行取得。人工與 AI 回覆分別標記 `cofacts-human`／`cofacts-ai`，每篇各最多 10 則，AI 只取 `SUCCESS`。`retrievalScore` 與 `relevanceScore` 分開保存。人工 reply 的 `reference`、hyperlinks 與原始文章的 references 分開；原始訊息出處不會充當人工查核引文，也不會送入 Gemma。

每筆 evidence 文字最多 6,000 個 UTF-16 code unit。綜整時另分配全體 evidence 共 60,000 的本文文字預算，以及各半的原始文章與引文文字預算，避免過量回覆超出 context。送入 Gemma 時，人工／AI 回覆放在 `evidenceText` 作為判定依據；原始文章只以 `untrustedArticleText` 提供回覆方向所需的語意上下文，prompt 明定其可能為假且不得當作證據。`related_checks` 由程式根據實際 Cofacts 證據建立，不由模型編造；每筆保留 Cofacts article URL。

Gemma 為唯一真假判斷階段。當送入模型的 evidence 為空陣列時，同一輪 prompt 要求模型改用一般常識評估，給出有意義的 `factuality` 與對應 `verdict`，並把 `confidence` 壓在 0.5 以下；常識也無法判斷時才回 `insufficient_evidence`。程式在模型信心值超過 0.5 時下修至 0.5，不整筆拒絕。evidence 非空時仍僅依證據判斷，不足就回 `insufficient_evidence`。各門檻仍須以真實 dataset 校準。

有 `cofacts-human`／`cofacts-ai` 證據時，使用者提供的 `provided-url` 證據會一併送入綜整模型，但一般網址僅作為背景：prompt 標記其為使用者提供、未經獨立驗證、優先序最低；若與其他證據衝突，依來源權威性、引用品質與時效比較，不可只按 source 或 reliability 標籤裁決，也不得僅憑一般使用者網址支持 claim。重新導向後的最終網址若為 `gov.tw`、`edu.tw` 或其子網域，或為 `https://tfc-taiwan.org.tw` 開頭的網址，則標記為 `allowlisted-institution`，在沒有 Cofacts 證據時仍可單獨送入模型作為機構參考資料；網址白名單不保證內文正確，模型仍須核對發布機關、適用範圍與時效。網址證據不進 `related_checks`；`meta.url_context_allowlisted` 回報最終網址是否在白名單，`meta.no_relevant_evidence` 只在 Cofacts 與白名單網址證據皆不存在時為 `true`。

綜整呼叫依 Gemma 4 的 Workers AI 官方設定帶 `chat_template_kwargs: { enable_thinking: false }`，避免模型把輸出額度耗在 reasoning 後留下空的 `message.content`。此模型的 Workers AI schema 支援兩項參數，不支援 `repetition_penalty`，參數效果仍需真實部署驗證。上游回應後先輸出 `synthesis_response`，只記錄 choice 數、白名單完成代碼、content 長度、有無 reasoning 與 token 用量，不記錄模型內容。綜整失敗時再輸出 `synthesis_error`，`reason` 為 `missing_binding`／`timeout`／`model_error`／`invalid_completion`／`incomplete_completion`／`invalid_content`／`invalid_content_json`／`invalid_synthesis`；chat completion 路徑另附白名單過濾後的 `finish_reason`（例如輸出達上限時為 `length`），gpt-oss 的 `response` 路徑沒有完成代碼，截斷只會以 `invalid_content_json` 呈現。診斷只含固定字串、完成代碼與延遲毫秒，不記錄模型內容或使用者原文；輸出 token 用量亦見同一 request ID 的 `usage` 事件。

## URL 抓取邊界

HTML 使用 Workers 原生 `HTMLRewriter` 移除腳本、樣式、樣板等內容，再解碼 HTML entities、擷取最多 12,000 個 UTF-16 code unit。網站需要 JavaScript 才產生的內容不會被執行。一般來源標為 `user-provided`，不自動視為可信；抓取成功且有 Cofacts 證據時作為最低優先序的背景送入綜整模型，查無 Cofacts 證據時不送入模型。最終 hostname 完全等於 `gov.tw`／`edu.tw` 或以 `.` 分隔的子網域，以及 HTTPS 且 hostname 完全等於 `tfc-taiwan.org.tw` 的網址，會標為 `allowlisted-institution` 並允許在 Cofacts 無證據時使用；`fakegov.tw`、`gov.tw.example.com`、`tfc-taiwan.org.tw.evil.example` 等相似名稱不會通過（見「證據契約」）。

DNS 預檢與 Workers `fetch()` 是兩次解析，無法在一般 Worker fetch 中釘選任意目標 IP；DNS rebinding 的最終隔離依賴 Cloudflare 執行環境。此 fetcher 不能直接移到可存取私網的 Node 伺服器；若要部署於該環境，需改用能固定連線 IP 的出口代理。模型 binding timeout 會停止等待，但 Workers AI API 沒有在本介面提供取消推論的方法，已送出的推論仍可能計費。

## 驗證

```bash
vp run check
vp run build
vp test
vp run typecheck
```

一般測試用假的 OpenRouter／Cofacts／Workers AI 傳輸，覆蓋完整 Hono pipeline、安全 gate、門檻、錯誤 fallback、分數分離與 SSRF 邊界。HTML extraction 另外以真正的本機 workerd 執行，使用 `workerd test` 直接呼叫測試 handler，不開啟本機 HTTP socket。

`tests/http-worker.test.ts` 將實際 Safeguard 與 DNS 程式碼打包後交給 workerd，驗證原生 `fetch` 可送出請求且拒絕上游重新導向。全部 outbound 由記憶體中的假上游回應，不讀取環境檔，也不連線外部服務。

`tests/fixtures/relevance-cases.json` 保存藍圖的四個 ID 與標註；一般回歸測試只驗證模型輸出的處理邏輯，不代表模型已通過語意驗收。真實回歸會取得原文，並透過 Workers AI remote binding 呼叫模型：

```bash
FACT_CHECK_LIVE=1 vp test tests/relevance.live.test.ts
```

此指令需要網路與已登入 Cloudflare，會使用 Workers AI 額度；不使用 OpenRouter key，也不讀本機 `.dev.vars`。完整正式服務驗收則需自行設定唯一 secret `OPENROUTER_API_KEY`，啟動 `vp run dev` 後，以 README 的 GET／POST 範例查核。

## 建置與紀錄

Vite build 禁用環境檔讀取，並清除僅供 preview 複製 secret 使用的外掛 `configPath`；產物不包含本機 secret。本機開發仍由 Cloudflare 外掛在執行期載入 `.dev.vars`。

程式 log 包含 request ID、文字長度、有無 URL、安全決策、候選 ID、搜尋／相關性分數、證據數量、最終判斷及階段時間，另有上述 Safeguard 設定與回應診斷；不紀錄使用者原文、完整 URL、上游錯誤 body 或 credential。Cloudflare 平台的請求紀錄由平台設定控制；敏感查核內容建議使用 POST，以免出現在網址歷史或 access log。

## 核對來源

- [Cofacts Article schema](https://github.com/cofacts/rumors-api/blob/master/src/graphql/models/Article.js)
- [Cofacts AIResponse schema](https://github.com/cofacts/rumors-api/blob/master/src/graphql/models/AIResponse.js)
- [gpt-oss-20b binding](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [Gemma binding 與 chat completion 輸出](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)
- [Cloudflare Vite secret 複製行為](https://developers.cloudflare.com/workers/vite-plugin/reference/secrets/)
