# Fact Check API

以 Cloudflare Workers、Hono 與 Vue SSR 建立的事實查核 API facade。這個 Worker 不再執行查核模型或 Cofacts pipeline，而是由 x402 付費閘門驗證付款，再透過 `FACT_CHECK_CORE` service binding 將請求轉送給獨立的 `fact-check-core` Worker。

首頁 `/` 的表單仍使用免費的 `/api/demo` 入口；需要逐次付費的整合者使用 `/api/fact-check`。兩個入口最後都呼叫相同的 fact-check-core，但只有 `/api/fact-check` 會要求 x402 付款。

## 架構

```text
/api/fact-check (GET／POST)
  → x402 PAYMENT-REQUIRED／PAYMENT-SIGNATURE
  → facilitator verify + settle
  → FACT_CHECK_CORE service binding
  → fact-check-core POST /fact-check

/api/demo (POST，免費)
  → Origin guard + CORS + IP rate limit
  → FACT_CHECK_CORE service binding
```

核心 Worker 的契約是 `POST /fact-check`（JSON `{ text, url? }`）與 `GET /health`。核心回應的本文及 `X-Request-Id`、`Cache-Control`、`X-Fact-Check-Cache` 等標頭會原樣轉送給呼叫端。

## 快速開始

需要 Node.js、npm、Vite+（`vp`）與 Cloudflare 帳號。查核模型憑證由 fact-check-core 管理，本 repo 不需要 OpenRouter API key 或 Workers AI binding。

```bash
vp install
cp .dev.vars.example .dev.vars
vp run dev
```

公開付款設定放在 `wrangler.jsonc` 的 `vars`：`PAY_TO` 是公開收款錢包，預設
`X402_NETWORK=eip155:8453`（Base mainnet）、`X402_PRICE=$0.05`，以及預設的
`FACILITATOR_URL=https://www.x402.org/facilitator`。demo 的公開預設限流也在 vars 設為
`RATE_LIMIT_WINDOW_MS=60000`。請依部署環境直接修改這些公開值。

本機 `.dev.vars` 只放敏感憑證，不要提交該檔案；`.dev.vars.example` 已提供 placeholder：

```dotenv
FACILITATOR_AUTH_TOKEN=your-facilitator-auth-token
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET=your-cdp-api-key-secret

# 本機 Base Sepolia 測試時才取消註解：
# X402_NETWORK=eip155:84532
# FACILITATOR_URL=https://www.x402.org/facilitator
```

`wrangler.jsonc` 也已設定 `FACT_CHECK_CORE` remote service binding。公開 x402.org facilitator
僅支援 Base Sepolia；Base mainnet 上線前請把 `FACILITATOR_URL` 改成 production facilitator，
並只透過 Cloudflare Secrets 注入所需憑證；不要把 facilitator 或 CDP secret 放進前端程式碼。

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

付費端點使用維護中的 `@x402/hono`（目前 `2.28.0`）搭配 `@x402/core`、`@x402/evm`。這組 SDK 提供 Hono middleware、Cloudflare Workers 可用的 HTTP facilitator client、可自訂 facilitator URL／認證標頭，以及 EVM `exact` scheme；因此比已停止演進介面較多的舊 `x402-hono` 更適合本 Worker。

付款流程：

1. 第一次呼叫不帶付款標頭，服務回 HTTP `402`。
2. 從 `PAYMENT-REQUIRED` 讀取 `payTo`、金額、網路與資產資訊。
3. 使用錢包依需求簽署付款，將編碼後的 `PAYMENT-SIGNATURE` 標頭（相容舊客戶端的 `X-PAYMENT` 也會被 SDK 讀取）加回**同一個 GET／POST 請求**重試。
4. facilitator 驗證並結算成功後，服務才轉送 fact-check-core；核心回應完成後回傳 `PAYMENT-RESPONSE`。

付費端點提供寬鬆瀏覽器 CORS：`Access-Control-Allow-Origin: *`，預檢允許 `Content-Type`、`PAYMENT-SIGNATURE` 與 `X-PAYMENT`，並 expose `PAYMENT-REQUIRED`、`PAYMENT-RESPONSE`、`X-Request-Id` 與 `Cache-Control`。

### 定價與設定

預設值如下，可由 Worker vars 切換：

| 變數                     | 預設值                                       | 說明                                       |
| ------------------------ | -------------------------------------------- | ------------------------------------------ |
| `PAY_TO`                 | `0x06818A198832EcEE8Dc8f9B1492C8915921EfEAB` | 公開收款錢包                               |
| `X402_NETWORK`           | `eip155:8453`                                | Base mainnet（CAIP-2）                     |
| `X402_PRICE`             | `$0.05`                                      | 每個 HTTP 請求一次付款，0.05 USDC          |
| `FACILITATOR_URL`        | `https://www.x402.org/facilitator`           | facilitator 根網址                         |
| `FACILITATOR_AUTH_TOKEN` | 未設定                                       | 可選 Bearer token secret                   |
| `CDP_API_KEY_ID`         | 未設定                                       | 可選 production facilitator API key ID     |
| `CDP_API_KEY_SECRET`     | 未設定                                       | 可選 production facilitator API key secret |

每一個請求都必須付款；服務不使用 JWT cookie 通行證或跨請求 session。修改 `X402_PRICE` 時，應同步確認 facilitator 與收款資產的支援，並在對外文件更新實際價格。

### Base Sepolia 測試網

本機或測試環境可改用 Base Sepolia：

```dotenv
X402_NETWORK=eip155:84532
FACILITATOR_URL=https://www.x402.org/facilitator
```

使用 Base Sepolia USDC 與公開 faucet 取得測試幣，再依 `PAYMENT-REQUIRED` 內容付款。公開 `x402.org` facilitator 目前支援測試網，適合整合測試；測試網付款沒有主網經濟價值。請從 Base 官方文件或可信的 Base Sepolia faucet 取得測試 ETH／USDC，勿把主網私鑰交給 faucet。

### Base mainnet 上線前置條件

公開 `https://www.x402.org/facilitator` 目前僅支援 Base Sepolia 測試網；Base mainnet 必須改用 Coinbase CDP 等 production facilitator，或自架且能處理 mainnet 的 facilitator。設定 `FACILITATOR_URL`，依所選 facilitator 要求填入 `FACILITATOR_AUTH_TOKEN` 或 `CDP_API_KEY_ID`／`CDP_API_KEY_SECRET` secrets。SDK 的 `HTTPFacilitatorClient` 支援自訂 path-specific headers；本 repo 會將上述 CDP 欄位以 facilitator 可辨識的 `x-api-key-id`／`x-api-key-secret` headers 傳送，但 production facilitator 若要求 CDP JWT 或不同 header 格式，須在部署前依其文件調整認證設定。沒有 production facilitator 憑證時不要把預設公開 facilitator 當成 mainnet 已可用。

### 已結算但核心失敗的風險

x402 middleware 會在核心成功回應後結算付款。若 facilitator 已結算而核心隨後不可用，服務會誠實回傳 `502 UPSTREAM_UNAVAILABLE`；x402 沒有內建退款機制，本服務也不假裝能退款。這是付款已 settle 但上游失敗的已知風險，呼叫端與服務維運者應將核心可用性納入監控與風險評估。

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
| 502  | `UPSTREAM_UNAVAILABLE`                     | service binding 不可用；可能已發生付款結算，見上方風險 |
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
