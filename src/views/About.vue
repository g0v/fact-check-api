<script setup lang="ts">
import NavBar from "../components/NavBar.vue";
</script>

<template>
  <NavBar current="about" />
  <main class="container">
    <h1>關於 Fact Check API</h1>
    <p>
      本 Worker 使用 x402 付費閘門保護 <code>/api/fact-check</code>。每次查核收取 0.05
      USDC，付款驗證與結算由 facilitator 處理，通過後再透過 <code>FACT_CHECK_CORE</code> service
      binding 呼叫獨立的 fact-check-core Worker。
    </p>
    <p>
      首頁表單仍使用免費的 <code>/api/demo</code>，保留 Origin guard、CORS 與 IP
      限流。付費端點預設使用 Base mainnet；整合測試可切換到 Base Sepolia。
    </p>
    <h2>自行部署</h2>
    <p>
      請設定 <code>PAY_TO</code>、<code>X402_NETWORK</code>、<code>X402_PRICE</code> 與
      <code>FACILITATOR_URL</code>，並確認 <code>FACT_CHECK_CORE</code> service binding
      指向可用的核心 Worker。 Base mainnet 需要 production facilitator；公開 x402.org facilitator
      僅支援測試網。
    </p>
    <p>
      <a href="https://github.com/g0v/fact-check-api/">查看原始碼</a>
    </p>
    <p><a href="/">回首頁</a></p>
  </main>
</template>
