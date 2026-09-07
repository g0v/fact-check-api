<script setup lang="ts">
import NavBar from "../components/NavBar.vue";
</script>

<template>
  <NavBar current="about" />
  <main class="container">
    <h1>關於 Fact Check API</h1>
    <p>
      本站目前只是 Demo，每日 Workers AI 用量有限，預設每日配額為 10,000 neurons（僅供大約 30
      次查核）。用量會透過 Durable Object 記帳，達到配額後當日便無法繼續查核。
    </p>
    <p>
      如果要正式使用，請先 fork
      <a href="https://github.com/g0v/fact-check-api/">本專案</a>，再自行部署到 Cloudflare Workers。
    </p>
    <h2>調整每日用量配額</h2>
    <p>
      請修改 <code>wrangler.jsonc</code> 的
      <code>"vars": { "DAILY_NEURON_BUDGET": "10000" }</code>。也可以在 Cloudflare Dashboard
      設定環境變數覆蓋這個值。
    </p>
    <p>
      預設值定義在 <code>src/api/config.ts</code> 的
      <code>BUDGET.dailyNeurons</code>，相關配額解析程式碼位於
      <code>src/api/services/usage-budget.ts</code> 的 <code>resolveDailyLimitNeurons</code>。
    </p>
    <p>
      <a href="https://github.com/g0v/fact-check-api/">查看原始碼</a>
    </p>
    <p><a href="/">回首頁</a></p>
  </main>
</template>
