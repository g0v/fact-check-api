<script setup lang="ts">
import { nextTick, onMounted, ref } from "vue";
import FactCheckValue from "./FactCheckValue.vue";
import { useFactCheckForm } from "../client/use-fact-check-form";

const {
  text,
  url,
  textLength,
  pending,
  error,
  result,
  httpStatus,
  requestId,
  submit: submitCheck,
} = useFactCheckForm();
const ready = ref(false);
const resultRegion = ref<HTMLElement | null>(null);
onMounted(() => {
  ready.value = true;
});
async function submit() {
  await submitCheck();
  await nextTick();
  resultRegion.value?.focus({ preventScroll: true });
}
</script>

<template>
  <section id="try-it" class="try-section" aria-labelledby="try-title">
    <div class="try-heading">
      <div>
        <p class="eyebrow">直接試用</p>
        <h2 id="try-title">查核一段文字</h2>
      </div>
      <span class="method">POST /api/fact-check</span>
    </div>
    <p class="form-intro">
      輸入你想確認的具體主張，也可以附上背景網址。結果會保留證據、原始分數與不確定性。
    </p>
    <form action="/api/fact-check" method="post" @submit.prevent="submit" :aria-busy="pending">
      <label for="check-text">待查核文字 <span class="required-label">必填</span></label>
      <textarea
        id="check-text"
        v-model="text"
        name="text"
        rows="4"
        required
        :disabled="pending"
        aria-describedby="check-text-help"
        placeholder="例如：非學校型態學生，國中小以下目前沒有普遍補助"
      ></textarea>
      <p id="check-text-help" class="form-help" :class="{ 'form-error': textLength > 10000 }">
        {{ textLength.toLocaleString() }} / 10,000 字 · 請盡量包含對象、時間與適用範圍。
      </p>
      <label for="check-url">背景網址 <span class="optional-label">選填</span></label>
      <input
        id="check-url"
        v-model="url"
        name="url"
        type="url"
        maxlength="2048"
        :disabled="pending"
        aria-describedby="check-url-help"
        placeholder="https://example.org/article"
      />
      <p id="check-url-help" class="form-help">公開 HTTP／HTTPS 網頁。不填網址也可以查核。</p>
      <div class="form-actions">
        <button class="button" type="submit" :disabled="!ready || pending">
          {{ pending ? "查核中…" : "開始查核" }}
        </button>
        <p role="status" aria-live="polite">
          {{
            pending
              ? "正在取得證據並綜整，模型回應可能需要一些時間。"
              : result
                ? "已收到回應，請查看下方結果。"
                : ""
          }}
        </p>
      </div>
    </form>
    <noscript><p class="form-error">請啟用 JavaScript，才能使用查核表單。</p></noscript>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <section
      v-if="result || httpStatus !== null"
      ref="resultRegion"
      class="live-result"
      tabindex="-1"
      aria-labelledby="live-result-title"
    >
      <div class="try-heading">
        <h3 id="live-result-title">本次查核回應</h3>
        <span class="http-status">HTTP {{ httpStatus }}</span>
      </div>
      <p v-if="requestId" class="form-help">
        回應標頭的請求識別碼 <code>{{ requestId }}</code
        >，可用於回報問題。
      </p>
      <p v-if="result && !result.ok" class="form-error">請求未成功完成，以下為伺服器回應。</p>
      <template v-if="result">
        <p class="form-help">
          以下依 API 實際回傳的欄位逐項顯示。數值不換算成百分比；未回傳的選填欄位不補值。
        </p>
        <FactCheckValue :value="result.data" path="" />
        <details class="code-details raw-result">
          <summary>查看完整原始回應</summary>
          <pre tabindex="0" aria-label="完整原始 API 回應"><code>{{ result.raw }}</code></pre>
        </details>
      </template>
    </section>
  </section>
</template>
