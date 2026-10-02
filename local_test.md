# fact-check-api 本機啟動與無真錢付款測試

本文件說明如何啟動本機 server，以及如何用全 mock 的付款流程驗證 `402 → verify → core → settle`，不使用主網錢包、不廣播鏈上交易，也不扣除真實 USDC。

## 測試層級

| 層級                         | 用途                                              | 是否可能連外                                               | 是否扣真錢                   |
| ---------------------------- | ------------------------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| 本機 server smoke test       | 確認 Worker、SSR、health 與未付款 402 能啟動      | 公開 facilitator 的 `supported`；remote binding 依路徑而定 | 否                           |
| `tests/x402-gateway.test.ts` | mock facilitator 與 core，完整驗證付款 middleware | 否                                                         | 否                           |
| Base Sepolia 整合測試        | 用真實測試網 facilitator、錢包及測試幣            | 是                                                         | 不扣主網資產，但會使用測試幣 |

日常開發建議以前兩層為主。Base Sepolia 是測試網整合，不是純 mock，只有需要驗證真實錢包簽章時才做。

## 一、安裝與本機設定

在專案根目錄安裝鎖定版本的依賴：

```bash
vp install
```

若尚未建立 `.dev.vars`，才複製範例：

```bash
cp .dev.vars.example .dev.vars
```

本機安全預設應為：

```dotenv
X402_NETWORK=eip155:84532
FACILITATOR_URL=https://www.x402.org/facilitator
```

純本機／mock 測試不應加入以下未註解的認證設定：

```dotenv
# CDP_API_KEY_ID=
# CDP_API_KEY_SECRET=
# FACILITATOR_AUTH_TOKEN=
```

不要保留 `your-cdp-api-key-id` 這類未註解 placeholder；程式會把非空字串視為已設定。若 `.dev.vars` 已存在，請手動確認變數名稱與組合即可，不要把內容貼到 issue、聊天或測試輸出。

依 Cloudflare 的[本機環境變數文件](https://developers.cloudflare.com/workers/local-development/environment-variables/)，`.dev.vars` 只供本機開發且不應提交。它不會替你設定 deployed Worker secrets。

## 二、啟動本機 server

```bash
vp run dev
```

以終端顯示的 Local URL 為準，Vite 常見預設是 `http://localhost:5173`。另開一個終端執行：

```bash
curl -i http://localhost:5173/health
curl -i "http://localhost:5173/api/fact-check?text=local-smoke-test"
```

預期結果：

1. `/health` 回 `200` 與 `{"status":"ok"}`。
2. 未帶 `PAYMENT-SIGNATURE` 或 `X-PAYMENT` 的 `/api/fact-check` 回 `402`。
3. 回應含 `PAYMENT-REQUIRED`，並描述 Base Sepolia 與本機設定的價格。
4. 這一步沒有付款簽章，不會進入 core，也不會 settle 或扣款。

目前 `wrangler.jsonc` 的 `FACT_CHECK_CORE` 設為 `remote: true`。未付款的 402 會在 core 前被擋下，因此上述 smoke test 不會呼叫 remote core；呼叫免費 `/api/demo` 或通過付款 middleware 後則可能使用遠端 `fact-check-core`，測試前要先確認這是你的本意。

## 三、執行完整 mock 付款流程

專案刻意沒有 `MOCK_PAYMENT=true` 或「接受任意假簽章」的 runtime 後門。完整的無真錢付款測試由測試程式載入同一套 Hono routes，並在記憶體中替換 facilitator 與 core：

```bash
vp test tests/x402-gateway.test.ts
```

這組測試會驗證：

- 未付款請求回 `402`，且 `PAYMENT-REQUIRED` 的 `payTo`、network、amount 正確。
- 覆寫 `X402_PRICE` 時，`accepts.amount` 與繁中 description 使用同一個價格。
- 模擬付款簽章後，順序為 facilitator `verify` → core → facilitator `settle`；`X-PAYMENT` 可承載 x402 v2 payload 完成相同流程。
- 同時提供兩個付款標頭時，`PAYMENT-SIGNATURE` 優先；無效的 canonical 值不會被有效的 `X-PAYMENT` 掩蓋。
- x402 v1 payload 不會被當成 v2 付款接受，也不會進入 core 或 settle。
- verify 失敗時不呼叫 core。
- core 回 `502` 或 fetch 拋錯時不 settle。
- GET／POST 都會以正確的 POST JSON 轉送 core。
- CDP JWT 分別綁定 `supported`、`verify`、`settle` 的 method、host、path，且為短效 token。
- CDP credentials 缺一或與固定 facilitator token 混用時會 fail closed。

測試中的簽章、payer、transaction hash 與 Ed25519 key 都是假資料或公開測試向量；`fetch` 與 core binding 均被 mock，不會呼叫 Coinbase、Cloudflare production Worker 或區塊鏈 RPC。

本機 server 與測試 runner 是兩個獨立驗證面向：`vp run dev` 證明實際開發 server 能啟動；`vp test tests/x402-gateway.test.ts` 則完整模擬付款狀態機，但不會把假付款送進正在監聽的 server。這個分離可避免測試 bypass 被誤帶到正式環境。

## 四、執行完整專案驗證

修改完成後執行：

```bash
vp run check
vp run build
vp test
```

全部通過代表格式／型別、production build 與現有測試均成功；它仍不等於已驗證 Coinbase 帳號、Cloudflare secrets 或真實鏈上結算。

## 五、可選：Base Sepolia 真實整合測試

若需要驗證真實錢包簽章，可以保留以下設定：

```dotenv
X402_NETWORK=eip155:84532
FACILITATOR_URL=https://www.x402.org/facilitator
```

再使用只持有 Base Sepolia 測試 ETH／USDC 的測試錢包，依 402 的 `PAYMENT-REQUIRED` 產生 x402 v2 `PAYMENT-SIGNATURE` 後重試同一請求；也可把同一 v2 payload 放在 `X-PAYMENT` 替代標頭。這不代表支援真正的 x402 v1。這會使用測試幣且需要連外，但沒有主網經濟價值。

安全注意事項：

- 不要使用主網錢包或主網私鑰。
- 不要把助記詞或私鑰放入 `.dev.vars`、curl 指令、程式碼或 shell history。
- faucet 只使用 Base／Coinbase 官方或可信來源。
- 先確認 402 中的 network 是 `eip155:84532`，不要在 mainnet `eip155:8453` 上做這項測試。

若目的只是確認程式流程，前一節的全 mock 測試已足夠，不必申請 CDP key 或取得測試幣。

## 常見問題

### 本機付費端點回 500

確認 `.dev.vars` 沒有使用 CDP production URL 卻漏掉 CDP key，也沒有只填 `CDP_API_KEY_ID` 或 `CDP_API_KEY_SECRET` 其中一個。純本機測試應使用 Base Sepolia + x402.org，並移除三個認證變數的非空值。

### facilitator 回報不支援 network

network 與 facilitator 組合不一致。公開 x402.org EVM exact 測試組合使用 `eip155:84532`；Base mainnet `eip155:8453` 使用正式 CDP 組合。

### 未付款 smoke test 沒有呼叫 core

這是正確行為。付款 middleware 會先回 402；只有付款 verify 成功後才會執行 core handler。
