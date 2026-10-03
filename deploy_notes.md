# fact-check-api 部署前申辦與設定筆記

本文件整理 Base mainnet 正式收款前需要申辦的服務、Cloudflare Secret 設定方式，以及部署前後的核對項目。正式設定以 [`wrangler.jsonc`](./wrangler.jsonc) 為準。

## 正式環境組合

| 項目                     | 正式值                                          | 性質                                          |
| ------------------------ | ----------------------------------------------- | --------------------------------------------- |
| Worker                   | `fact-check`                                    | Cloudflare Worker 名稱                        |
| `X402_NETWORK`           | `eip155:8453`                                   | Base mainnet                                  |
| `X402_PRICE`             | `$0.05`                                         | 每次請求的 USDC 價格                          |
| `FACILITATOR_URL`        | `https://api.cdp.coinbase.com/platform/v2/x402` | Coinbase CDP facilitator                      |
| `CDP_API_KEY_ID`         | 從 CDP Secret API Key 取得                      | Cloudflare Secret                             |
| `CDP_API_KEY_SECRET`     | 從同一把 CDP Secret API Key 取得                | Cloudflare Secret                             |
| `FACILITATOR_AUTH_TOKEN` | 不設定                                          | 僅供其他 facilitator 的固定 Bearer token 使用 |

`PAY_TO` 必須在部署前再次確認為實際要收款的 Base 錢包地址。正式 mainnet 組合不能改用只支援 Base Sepolia 的公開 x402.org facilitator。

上述四個付款設定都是必要值。任何 deployment environment 若漏掉 `PAY_TO`、`X402_NETWORK`、`X402_PRICE` 或 `FACILITATOR_URL`（包含空字串／純空白），付費 GET／POST 會回 `500 INTERNAL_ERROR`，不產生付款要求，也不呼叫 facilitator 或 core；程式不會 fallback 到 Base Sepolia 或公開 x402.org facilitator。preview／其他 environment 也必須明確提供付款設定。

## 一、準備帳號與資源

部署前需要：

1. 可部署 Workers 的 Cloudflare 帳號。
2. 已登入或可登入的 [Coinbase Developer Platform Portal](https://portal.cdp.coinbase.com/)。
3. 一個 CDP project。
4. 已部署且可供 service binding 使用的 `fact-check-core` Worker；目前 binding 名稱是 `FACT_CHECK_CORE`。
5. 自己控制、可在 Base mainnet 收取 USDC 的 `PAY_TO` 地址。

CDP facilitator 使用的是 server-to-server **Secret API Key**。本專案不需要 Client API Key、Wallet Secret，也不需要向 Coinbase 另外申請 `FACILITATOR_AUTH_TOKEN`。

## 二、建立 Coinbase CDP Secret API Key

依 [CDP 官方 API Authentication 文件](https://docs.cdp.coinbase.com/api-reference/v2/authentication)操作：

1. 登入 CDP Portal，進入 [Secret API Keys](https://portal.cdp.coinbase.com/api-keys/secret) 頁面。
2. 從上方選擇正確的 project。
3. 切換到 **Secret API Keys**，不要選 Client API Key。
4. 選擇 **Create API key**，使用能辨認用途的名稱，例如 `fact-check-api-production`。
5. 視需要設定 IP allowlist 與權限限制；簽章演算法優先選官方建議的 **Ed25519**。
6. 建立後立即安全保存畫面中的 Key ID 與 Secret。Secret 不應貼入 issue、聊天、README、原始碼或 `wrangler.jsonc`。

若下載到 JSON key file，本專案使用的欄位對應如下：

| CDP key file 欄位 | Cloudflare Secret 名稱 |
| ----------------- | ---------------------- |
| `id`              | `CDP_API_KEY_ID`       |
| `privateKey`      | `CDP_API_KEY_SECRET`   |

這兩個值必須來自**同一把 key**並成對設定。程式會用 `@coinbase/cdp-sdk` 即時產生綁定 `supported`、`verify`、`settle` 請求的短效 JWT；不要自行建立一個 JWT 再存成長期 Secret。

## 三、把 Secret 安全送進 Cloudflare

先在專案根目錄確認登入的 Cloudflare 帳號：

```bash
npx wrangler login
npx wrangler whoami
```

確認帳號後，用互動提示逐一輸入兩個值：

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
```

每個指令執行後，Wrangler 才會提示輸入值。不要把 Secret 寫在指令參數、shell history 或可提交的檔案中。

若 `fact-check` Worker 尚不存在，Wrangler 可能先詢問是否建立同名 draft Worker。只有在 `whoami` 顯示正確帳號、Worker 名稱確定為 `fact-check` 時才確認；若 Worker 已存在卻仍出現此提示，先取消並檢查登入帳號與名稱，避免把 Secret 寫到錯誤目標。

依 Cloudflare 的 [Workers Secrets 文件](https://developers.cloudflare.com/workers/configuration/secrets/)，`wrangler secret put` 會建立新的 Worker version 並立即部署該版本；它不是純本機設定。若組織採用 gradual deployment，應改用組織既定的 `wrangler versions secret put`／version deployment 流程。

只確認 Secret 名稱是否存在、不顯示內容：

```bash
npx wrangler secret list
```

預期清單包含：

```text
CDP_API_KEY_ID
CDP_API_KEY_SECRET
```

也可以在 Cloudflare Dashboard 的 **Workers & Pages → fact-check → Settings → Variables and Secrets** 新增，類型必須選 **Secret**，然後按 Deploy。不要選成可讀取明文的普通 variable。

> `.dev.vars` 只供本機開發，不會自動上傳成 deployed Worker secrets，也不應提交至 Git。

## 四、部署前核對

逐項確認：

- `PAY_TO` 是預期的 Base mainnet 收款地址，而且私鑰由正確的人或組織控制。
- `X402_NETWORK` 是 `eip155:8453`。
- `FACILITATOR_URL` 是 `https://api.cdp.coinbase.com/platform/v2/x402`。
- `X402_PRICE` 是預期售價；目前 `$0.05` 會在 402 說明與 `accepts.amount` 同步呈現。
- Cloudflare 上同時存在 `CDP_API_KEY_ID` 與 `CDP_API_KEY_SECRET`。
- Cloudflare 上沒有為這個 CDP 組合設定 `FACILITATOR_AUTH_TOKEN`。
- `fact-check-core` 位於正確帳號，且 `FACT_CHECK_CORE` service binding 能解析到它。
- `PAYMENT_CLAIM_DO` 綁定 `PaymentClaimDO`，所有服務同一付款入口的 isolate／Worker 共用相同 namespace；缺少 binding 或 claim 服務失敗時付費請求回 `500 PAYMENT_CLAIM_UNAVAILABLE`，不進入 core。
- 沒有把 CDP Secret、錢包私鑰或其他 credential 放入 Git diff。

### Durable Object 遷移警示：`UsageBudget`

`wrangler.jsonc` 保留既有 `v1`（建立 `UsageBudget`）與 `v2`（建立 `RateLimiterDO`）migration 紀錄，並追加 `v3` `deleted_classes: ["UsageBudget"]`。這依循 Cloudflare 的 [legacy Durable Object migration 規則](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/#delete-migration)：`v3` 只刪除 `UsageBudget` namespace，不會刪除 `RateLimiterDO` 或其他 Durable Object namespace。

本次只修改本機設定，尚未將 `v3` migration 套用至 Cloudflare。設定檔或 dry run 都不能證明遠端 migration 已套用或成功，也不能確認遠端目前狀態。之後以此設定執行正式部署時，Cloudflare 會永久刪除 `UsageBudget` 所屬 namespace、其中所有 Durable Object 與全部儲存資料；這不是軟刪除，也沒有復原區。

部署前必須先備份任何需要保留的 `UsageBudget` 資料、確認 Worker 與其他使用者都不再依賴該 namespace，並取得資料／服務負責人對永久刪除的明確核准。在備份、依賴確認及核准完成前，不得執行會套用此 migration 的正式部署。

### 付款防重放 Durable Object

`v4` 以 `new_sqlite_classes: ["PaymentClaimDO"]` 建立付款 authorization 的持久化原子 claim，`PAYMENT_CLAIM_DO` 指向此 class；既有 `v1`、`v2`、`v3` 歷史不改動。這項新增不刪除其他 namespace，但若同次部署尚未套用的 `v3`，上述永久刪除警示仍適用。此次尚未部署，也未驗證遠端 migration。

claim 在 verify 成功後、core 執行前取得；相同 authorization 並發或重放回 `409 PAYMENT_ALREADY_CLAIMED`。記錄保留至 EIP-3009 `validBefore` 加 60 秒，之後 alarm 清理儲存；不因 core／settle 失敗或 Worker 中斷而提前釋放。客戶端須以新 nonce 簽署重試；不能把 TTL 改成較短租約，否則仍在執行的 core 可能被並發重入。

執行專案固定驗證與部署 dry run：

```bash
vp run check
vp run build
vp test
npx wrangler deploy --dry-run
```

dry run 只驗證建置與封裝，不會證明遠端 Secret 值正確、facilitator 可用、service binding 能正常呼叫，也不會套用或證明 `UsageBudget` 的遠端 migration 已成功。

## 五、部署與 smoke test

確認目標帳號、vars、bindings 與 secrets 都正確後才執行：

```bash
vp run deploy
```

部署完成後，先做不會產生付款的檢查。以下以實際 Worker 網址取代 `<WORKER_URL>`：

```bash
curl -i "<WORKER_URL>/health"
curl -i "<WORKER_URL>/api/fact-check?text=deployment-smoke-test"
```

預期：

- `/health` 回 `200` 與 `{"status":"ok"}`。
- 未帶付款標頭的 `/api/fact-check` 回 `402`。
- `PAYMENT-REQUIRED` 描述的是 Base mainnet、目前 `PAY_TO` 與實際 `X402_PRICE`。
- 未付款的 402 不會呼叫 core，也不會 settle 或扣款。

若要做真正的 mainnet paid smoke test，會實際支付 `X402_PRICE` 指定的 USDC；執行前必須由付款錢包持有人明確確認。無真錢的完整付款流程請改用 [`local_test.md`](./local_test.md) 的 mock 測試。

## 六、更新與撤銷 Secret

輪替 CDP key 時，先建立新 key，再更新 Cloudflare 上的兩個 Secret，完成驗證後才撤銷舊 key，避免 ID 與 Secret 暫時不成對。

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
```

若不再使用 CDP，先完成 facilitator 與 network 的設定遷移，再刪除 secrets：

```bash
npx wrangler secret delete CDP_API_KEY_ID
npx wrangler secret delete CDP_API_KEY_SECRET
```

`secret put` 與 `secret delete` 都會建立並部署 Worker version；正式環境操作前要先確認變更窗口與回復方式。
