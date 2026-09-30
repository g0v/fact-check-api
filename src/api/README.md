# API 維護指南

本目錄提供 Worker 的 HTTP API。查核流程不在此執行；`/api/fact-check` 由 x402 middleware 驗證逐次付款後，透過 `FACT_CHECK_CORE` service binding 呼叫獨立的 `fact-check-core` Worker。首頁使用的 `/api/demo` 保持免費，並保留來源保護、CORS 與 IP 限流。

## 閱讀順序

1. `index.ts`：request ID、`Cache-Control: no-store` 與統一錯誤回應。
2. `routes/fact-check.ts`：GET／POST 輸入驗證、GET→POST core 轉換與 x402 閘門。
3. `middleware/x402.ts`：`@x402/hono` 設定、EVM exact scheme、facilitator URL／認證與 vars 預設值。
4. `routes/demo.ts`：免費 facade；不要把此路由改成付費或移除 Origin guard、CORS、`ipRateLimit`。
5. `middleware/cors.ts`、`middleware/origin.ts`、`middleware/rate-limit.ts`：免費 demo 的既有守護，以及付費端點的寬鬆 CORS。
6. `types/fact-check.ts`：service binding、付款設定與 rate-limit binding 的最小型別。

## x402 閘門

付款設定由 Worker vars／secrets 注入：

- `PAY_TO` 預設為公開收款錢包。
- `X402_NETWORK` 預設 `eip155:8453`（Base mainnet）。
- `X402_PRICE` 預設 `$0.05`，每個請求都要重新付款。
- `FACILITATOR_URL` 預設公開 x402 facilitator。
- `FACILITATOR_AUTH_TOKEN`、`CDP_API_KEY_ID`、`CDP_API_KEY_SECRET` 為可選認證 secrets。

每次請求先由 middleware 建立 `PAYMENT-REQUIRED`。帶有有效 `PAYMENT-SIGNATURE`（相容 `X-PAYMENT`）時，SDK 先呼叫 facilitator `verify`，再讓請求進入路由與 core；handler 回應小於 `400` 才呼叫 `settle`，成功後附上 `PAYMENT-RESPONSE`。handler 回 `>=400` 或拋例外時不走正常結算，錯誤留在原本的回應／錯誤流程。

`x402.org` 公開 facilitator 目前只支援 Base Sepolia。上線 Base mainnet 前，必須改用 production facilitator（例如 Coinbase CDP）或自架服務，並依服務文件設定 authentications。SDK 的 `HTTPFacilitatorClient` 提供 path-specific custom headers；若 production service 要求 CDP JWT 或不同 header 格式，須在部署前調整 `middleware/x402.ts`。

付費端點 CORS 固定回 `Access-Control-Allow-Origin: *`，預檢允許 `Content-Type`、`PAYMENT-SIGNATURE`、`X-PAYMENT`，並 expose `PAYMENT-REQUIRED`、`PAYMENT-RESPONSE`、`X-Request-Id`、`Cache-Control`。不設 cookie 或 JWT 通行證。

## core proxy

`POST /api/fact-check` 只轉送 `{ text, url? }` JSON；`GET /api/fact-check?text=...&url=...` 會先解析並驗證 query，再建立新的 POST JSON request 給 core。呼叫端的 HTTP 方法不會原樣傳給 core，core 一律收到 `POST /fact-check`。core 回應本文與 headers 原樣回傳。

service binding 未設定或 `fetch()` 拋出例外時回 `502 UPSTREAM_UNAVAILABLE`；由於這是 handler 錯誤，付款不會結算，客戶端不被扣款。core 回 `2xx` 但內容為業務錯誤時仍可能結算；此外 settle 本身的網路失敗需要另外確認付款狀態。x402 沒有內建退款。

## 免費 demo 守護

`/api/demo` 維持：

- POST `Origin` guard：同源或正式來源／本機來源清單才允許。
- 既有來源回填 CORS 與預檢處理。
- `RATE_LIMITER` + `RATE_LIMIT_DO` 的 IP 流量限制；精準冷卻預設每個 IP 每 60 秒一次。
- POST body 原樣轉成 core `/fact-check` request。

`RATE_LIMITER` 仍是每 10 秒 30 次的洪水層；`RATE_LIMIT_WINDOW_MS` 可覆寫 60 秒的
`RATE_LIMIT_DO` 冷卻時間。這些守護只屬於免費 demo；付費查核完全由 x402 負責付款，
不能把 demo 的 Origin 或 IP 限制套回付費路由。

## 輸入限制與錯誤

- `text` 必填，最多 10,000 個 Unicode code point。
- `url` 選填，限公開 HTTP／HTTPS 網址，最多 2,048 個字元，不可含帳號密碼或內網位址。
- POST `Content-Type` 必須為 `application/json`，本文最多 128,000 bytes。
- 設定、錯誤訊息與對使用者可見字串使用繁體中文；固定 error code 與 API 欄位維持英文契約。

`wrangler.jsonc` 的 `migrations` `v1`、`v2` 標籤是既有 Durable Object migration 紀錄，必須保留，即使目前只使用 `RATE_LIMIT_DO`。不要刪改已套用的 migration tag。
