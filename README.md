# Fact Check API

以 Cloudflare Workers、Hono 與 Vue SSR 建立的事實查核 API facade。這個 Worker 不再執行查核模型或 Cofacts pipeline，而是由 x402 付費閘門驗證付款，再透過 `FACT_CHECK_CORE` service binding 將請求轉送給獨立的 `fact-check-core` Worker。

首頁 `/` 的表單仍使用免費的 `/api/demo` 入口；需要逐次付費的整合者使用 `/api/fact-check`。兩個入口最後都呼叫相同的 fact-check-core，但只有 `/api/fact-check` 會要求 x402 付款。

## 架構

```text
/api/fact-check (GET／POST)
  → x402 PAYMENT-REQUIRED／PAYMENT-SIGNATURE
  → facilitator verify
  → FACT_CHECK_CORE service binding
  → fact-check-core POST /fact-check
  → 核心回應 <400：facilitator settle → PAYMENT-RESPONSE
  ↳ 核心回 >=400／fetch 失敗：直接回錯誤，不 settle

/api/demo (POST，免費)
  → Origin guard + CORS + IP rate limit
  → FACT_CHECK_CORE service binding
```

核心 Worker 的契約是 `POST /fact-check`（JSON `{ text, url? }`）與 `GET /health`。核心回應的本文及 `X-Request-Id`、`Cache-Control`、`X-Fact-Check-Cache` 等標頭會原樣轉送給呼叫端。

## 快速開始

需要 Node.js、npm、Vite+（`vp`）與 Cloudflare 帳號。查核模型憑證由 fact-check-core 管理，本 repo 不需要 OpenRouter API key 或 Workers AI binding。

操作文件：

- [正式部署前申辦、CDP Secret 與 Cloudflare 設定](./deploy_notes.md)
- [本機 server 與無真錢 mock 付款測試](./local_test.md)

```bash
vp install
cp .dev.vars.example .dev.vars
vp run dev
```

正式部署的公開付款設定放在 `wrangler.jsonc` 的 `vars`：`PAY_TO` 是公開收款錢包，
`X402_NETWORK=eip155:8453`（Base mainnet）、`X402_PRICE=$0.05`，並使用
`FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`。demo 的公開預設限流也在
vars 設為 `RATE_LIMIT_WINDOW_MS=60000`。部署前必須另外建立 CDP Secret API Key，並把 ID
與 Secret 設為 Cloudflare secrets。

本機 `.dev.vars` 不要提交。複製 `.dev.vars.example` 後會覆寫正式設定，改用不需憑證的 Base
Sepolia 公開 facilitator：

```dotenv
PAY_TO=0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB
X402_NETWORK=eip155:84532
X402_PRICE=$0.05
FACILITATOR_URL=https://www.x402.org/facilitator

# 改用 CDP 時才填入，而且兩個值必須成對：
# CDP_API_KEY_ID=your-cdp-api-key-id
# CDP_API_KEY_SECRET=your-cdp-api-key-secret

# 只有其他 facilitator 提供固定 Bearer token 時才使用：
# FACILITATOR_AUTH_TOKEN=your-facilitator-auth-token
```

`wrangler.jsonc` 也已設定 `FACT_CHECK_CORE` remote service binding。公開 x402.org facilitator
的 EVM exact scheme 僅支援 Base Sepolia；正式 Base mainnet 使用 CDP。不要把 facilitator 或 CDP
secret 放進前端程式碼。

## API

| 方法 | 路徑              | 付款                 | 用途                             |
| ---- | ----------------- | -------------------- | -------------------------------- |
| GET  | `/`               | 無                   | SSR 首頁與免費表單               |
| GET  | `/health`         | 無                   | 回傳 `{"status":"ok"}`           |
| GET  | `/api/fact-check` | x402，每次 0.05 USDC | query string 轉 JSON 後轉送 core |
| POST | `/api/fact-check` | x402，每次 0.05 USDC | 轉送 JSON 至 core                |
| POST | `/api/demo`       | 免費                 | 首頁使用的 core facade           |

`/api/fact-check` 接受 `text`（必要，最多 10,000 個 Unicode code point）與 `url`（選填，公開 HTTP／HTTPS 網址，最多 2,048 個字元）。POST 必須使用 `Content-Type: application/json`，本文最多 128,000 bytes。輸入驗證在付款放行後執行，避免未付款請求繞過閘門。

### 免費 demo

首頁表單維持原本的免費入口：

```javascript
const response = await fetch("/api/demo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "非學校型態學生，國中小以下目前沒有普遍補助" }),
});
const result = await response.json();
```

`/api/demo` 的 POST Origin guard、正式來源 CORS 仍維持；它是唯一免費入口，預設每個 IP
每 60 秒最多一次，另有 Cloudflare `RATE_LIMITER` 每 10 秒 30 次的洪水層。可在
`wrangler.jsonc` 的 `RATE_LIMIT_WINDOW_MS` vars 覆寫精準冷卻時間。demo 不是付款驗證或身分驗證，
請勿把它當成付費 API 的替代入口。

## x402 付款

付費端點使用維護中的 `@x402/hono`（目前 `2.28.0`）搭配 `@x402/core`、`@x402/evm`。
Coinbase CDP 認證使用官方 `@coinbase/cdp-sdk` 的 `generateJwt()`，為
`supported`、`verify`、`settle` 各自產生綁定 HTTP method、host 與 path 的短效 JWT；不會把 CDP
API Key Secret 直接送到 facilitator。

付款流程：

1. 第一次呼叫不帶付款標頭，服務回 HTTP `402`。
2. 從 `PAYMENT-REQUIRED` 讀取 `payTo`、金額、網路與資產資訊。
3. 使用錢包依需求簽署 x402 v2 付款，將編碼後的 v2 payload 放入 `PAYMENT-SIGNATURE`，或以 `X-PAYMENT` 作為同一 v2 payload 的替代標頭，再加回**同一個 GET／POST 請求**重試。`X-PAYMENT` 僅是 v2 替代標頭，不代表支援 x402 v1。
4. facilitator 先 verify；驗證成功後才轉送 fact-check-core。核心 handler 回應 <400（本 API 正常為 2xx）
   才呼叫 settle，成功後回傳 `PAYMENT-RESPONSE`；核心回 `>=400` 或 fetch 失敗轉成 502 時直接回錯誤，
   不會結算付款。

付費端點提供寬鬆瀏覽器 CORS：`Access-Control-Allow-Origin: *`，預檢允許 `Content-Type`、`PAYMENT-SIGNATURE` 與 `X-PAYMENT`，並 expose `PAYMENT-REQUIRED`、`PAYMENT-RESPONSE`、`X-Request-Id` 與 `Cache-Control`。

### 定價與設定

以下為 `wrangler.jsonc` 的正式設定，可由 Worker vars 切換；不是 production code 的 runtime fallback。`PAY_TO`、`X402_NETWORK`、`X402_PRICE`、`FACILITATOR_URL` 必須明確提供，未設定、空字串或純空白時，付費 GET／POST 回 `500 INTERNAL_ERROR`，不產生付款要求，也不呼叫 facilitator 或 core；不會自動降級到測試網。

| 變數                     | 正式設定                                        | 說明                                     |
| ------------------------ | ----------------------------------------------- | ---------------------------------------- |
| `PAY_TO`                 | `0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB`    | 公開收款錢包                             |
| `X402_NETWORK`           | `eip155:8453`                                   | Base mainnet（CAIP-2）                   |
| `X402_PRICE`             | `$0.05`                                         | 每個 HTTP 請求一次付款，0.05 USDC        |
| `FACILITATOR_URL`        | `https://api.cdp.coinbase.com/platform/v2/x402` | CDP production facilitator 根網址        |
| `FACILITATOR_AUTH_TOKEN` | 未設定                                          | 其他 facilitator 可選的固定 Bearer token |
| `CDP_API_KEY_ID`         | 未設定                                          | CDP Secret API Key ID                    |
| `CDP_API_KEY_SECRET`     | 未設定                                          | CDP Secret API Key Secret                |

每一個請求都必須付款；服務不使用 JWT cookie 通行證或跨請求 session。修改 `X402_PRICE` 時，應同步確認 facilitator 與收款資產的支援，並在對外文件更新實際價格。

### Base Sepolia 測試網

本機或測試環境可改用 Base Sepolia：

```dotenv
X402_NETWORK=eip155:84532
FACILITATOR_URL=https://www.x402.org/facilitator
```

使用 Base Sepolia USDC 與公開 faucet 取得測試幣，再依 `PAYMENT-REQUIRED` 內容付款。公開 `x402.org` facilitator 目前支援測試網，適合整合測試；測試網付款沒有主網經濟價值。請從 Base 官方文件或可信的 Base Sepolia faucet 取得測試 ETH／USDC，勿把主網私鑰交給 faucet。

### Base mainnet 上線前置條件

公開 `https://www.x402.org/facilitator` 的 EVM exact scheme 目前僅支援 Base Sepolia 測試網；
`wrangler.jsonc` 的 Base mainnet 正式設定已改用 Coinbase CDP。請先在 Coinbase Developer Platform
建立一把 **Secret API Key**，它會同時提供 Key ID 與 Key Secret；不需要另外向 Coinbase 申請
`FACILITATOR_AUTH_TOKEN`。接著以互動輸入設定 Cloudflare secrets，避免值出現在 shell history：

```bash
npx wrangler secret put CDP_API_KEY_ID
npx wrangler secret put CDP_API_KEY_SECRET
```

兩個 CDP 值必須成對設定，且不可與 `FACILITATOR_AUTH_TOKEN` 混用。後者只適用於明確提供固定
Bearer token 的其他 facilitator。middleware 會透過 Coinbase 官方 SDK 即時產生約兩分鐘有效、
綁定個別 facilitator 路徑的 JWT；`FACILITATOR_AUTH_TOKEN` 不是拿來保存這種短效 CDP JWT。

### 核心錯誤與結算風險

x402 middleware 先 verify，再執行 handler；SDK 對 handler 回應 `>=400` 不呼叫 settle，而是把錯誤回給客戶端。因此 core 回 `>=400`，或 core fetch 失敗由本 Worker 轉成 `502 UPSTREAM_UNAVAILABLE` 時，不會結算，客戶端不被扣款。真正的殘餘風險是 core 回 `2xx` 但本文內容其實是業務錯誤時仍會結算，以及 settle 本身發生網路失敗時需要另外確認付款狀態；x402 沒有內建退款機制。

## 回應與錯誤

付費成功時，核心 JSON 與核心回應標頭不改寫。服務自身會維持 `X-Request-Id` 與 `Cache-Control: no-store`。

常見錯誤：

| HTTP | 錯誤                                       | 說明                                                   |
| ---- | ------------------------------------------ | ------------------------------------------------------ |
| 402  | `PAYMENT_REQUIRED` 或 facilitator 驗證錯誤 | 依 `PAYMENT-REQUIRED` 付款後重試                       |
| 400  | `INVALID_INPUT`                            | 修正 JSON、文字或網址                                  |
| 413  | `PAYLOAD_TOO_LARGE`                        | 縮短 POST 本文                                         |
| 403  | `FORBIDDEN_ORIGIN`                         | 僅適用免費 `/api/demo` 的 Origin guard                 |
| 429  | `RATE_LIMITED`                             | 僅適用免費 demo 的 IP 限流，依 `Retry-After` 重試      |
| 502  | `UPSTREAM_UNAVAILABLE` 或 facilitator 錯誤 | core 錯誤不 settle；若發生在 settle 階段需另查付款狀態 |
| 500  | `INTERNAL_ERROR`                           | 提供 `X-Request-Id` 協助排查                           |

## 首頁與本機開發

首頁保留查核表單與查核結果呈現；說明區明確標示 `/api/fact-check` 是每次 0.05 USDC 的 x402 付費 API，並提供免費 `/api/demo` 入口。表單繼續送往 `/api/demo`，不會在沒有錢包付款流程的情況下阻斷一般使用者。

```bash
vp run dev
vp run check
vp run build
vp test
```

`design/fact_check_MVP_plan.md` 是早期 pipeline 規劃，保留作歷史資料；現行架構與部署設定以本 README 為準。

## 授權

程式碼採 [MIT License](./LICENSE)。
