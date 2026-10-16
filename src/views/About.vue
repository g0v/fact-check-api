<script setup lang="ts">
import NavBar from "../components/NavBar.vue";
</script>

<template>
  <NavBar current="about" />
  <main class="container">
    <h1>關於 Fact Check API</h1>
    <p>
      本 Worker 使用 x402 付費閘門保護 <code>/api/fact-check</code>。每次查核收取 0.05
      USDC。facilitator 先 verify 付款；驗證成功後才透過 <code>FACT_CHECK_CORE</code> service
      binding 呼叫獨立的 fact-check-core Worker，只有 handler 回應小於 400 才 settle
      並回傳付款結果。core 回傳錯誤或 fetch 失敗轉成 502 時不會結算付款。
    </p>
    <p>
      首頁表單仍使用免費的 <code>/api/demo</code>，保留 Origin guard、CORS 與 IP 限流（預設每個 IP
      每 60 秒一次，可由 <code>RATE_LIMIT_WINDOW_MS</code> 覆寫）。正式付費端點設定使用 Base mainnet
      與 CDP；本機整合測試預設使用 Base Sepolia 公開 facilitator。
    </p>
    <h2>自行部署</h2>
    <p>
      請設定 <code>PAY_TO</code>、<code>X402_NETWORK</code>、<code>X402_PRICE</code> 與
      <code>FACILITATOR_URL</code>，並確認 <code>FACT_CHECK_CORE</code> service binding
      指向可用的核心 Worker。Base mainnet 的 CDP facilitator 需要成對的 Secret API Key ID／Secret，
      由官方 SDK 產生短效 JWT；公開 x402.org facilitator 僅支援測試網。
    </p>
    <p>
      <a href="https://github.com/g0v/fact-check-api/">查看原始碼</a>
    </p>
    <p><a href="/">回首頁</a></p>
  </main>
</template>
