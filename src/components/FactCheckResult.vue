<script setup lang="ts">
import { computed } from "vue";
import FactCheckValue from "./FactCheckValue.vue";
import { safeSourceLink, valueLabel } from "../client/fact-check-fields";
import { summarizeFactCheck } from "../client/fact-check-summary";

const props = defineProps<{ data: unknown }>();
const summary = computed(() => summarizeFactCheck(props.data));

type SourceView = {
  typeText: string;
  text: string | null;
  cofactsUrl: string | undefined;
  references: string[];
};
const sources = computed<SourceView[]>(() =>
  (summary.value?.relatedChecks ?? []).map((item) => {
    const check =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : {};
    const references = [
      ...(typeof check.reference_url === "string" ? [check.reference_url] : []),
      ...(Array.isArray(check.reference_urls)
        ? check.reference_urls.filter((url): url is string => typeof url === "string")
        : []),
    ];
    return {
      typeText:
        (typeof check.type === "string" && valueLabel("related_checks[].type", check.type)) ||
        "查核回覆",
      text: typeof check.text === "string" ? check.text : null,
      cofactsUrl:
        typeof check.url === "string"
          ? safeSourceLink("related_checks[].url", check.url)
          : undefined,
      references: [...new Set(references)]
        .map((url) => safeSourceLink("related_checks[].reference_urls[]", url))
        .filter((url): url is string => Boolean(url)),
    };
  }),
);
</script>

<template>
  <template v-if="summary">
    <section class="result-summary" aria-label="查核結果摘要">
      <p class="verdict-line">
        <strong class="verdict-text">{{ summary.verdictText }}</strong>
        <code class="verdict-code">{{ summary.verdict }}</code>
      </p>
      <p v-if="summary.assessment" class="assessment-line">{{ summary.assessment }}</p>
      <p
        v-if="summary.factuality !== null || summary.confidence !== null"
        class="assessment-numbers"
      >
        <span v-if="summary.factuality !== null"
          >支持度 <code>factuality</code>
          <span class="result-number">{{ summary.factuality }}</span></span
        >
        <span v-if="summary.confidence !== null"
          >信心 <code>confidence</code>
          <span class="result-number">{{ summary.confidence }}</span></span
        >
      </p>
      <p class="form-help">
        分數為 0～1 的原始值，不是百分比；支持度不等於主張為真的機率，請搭配信心一起閱讀。
      </p>
      <template v-if="summary.feedback">
        <h4>查核說明</h4>
        <p class="result-value summary-feedback">{{ summary.feedback }}</p>
      </template>
      <h4>查核來源</h4>
      <p v-if="sources.length === 0" class="result-empty">本次沒有取得相關查核來源。</p>
      <ol v-else class="source-list">
        <li v-for="(source, index) in sources" :key="index" class="source-item">
          <p class="source-heading">
            <span class="source-type">{{ source.typeText }}</span>
            <a
              v-if="source.cofactsUrl"
              :href="source.cofactsUrl"
              target="_blank"
              rel="noopener noreferrer"
              >Cofacts 原文 ↗</a
            >
          </p>
          <p v-if="source.text" class="result-value source-text">{{ source.text }}</p>
          <p v-if="source.references.length" class="source-references">
            引用來源：<a
              v-for="reference in source.references"
              :key="reference"
              :href="reference"
              target="_blank"
              rel="noopener noreferrer"
              >{{ reference }}</a
            >
          </p>
        </li>
      </ol>
      <details v-if="sources.length" class="code-details source-details">
        <summary>查核來源完整欄位（含原始分數）</summary>
        <FactCheckValue :value="summary.relatedChecks" path="related_checks" />
      </details>
    </section>
    <section class="result-rest" aria-label="流程狀態與其他欄位">
      <h4>流程狀態與其他欄位</h4>
      <p class="form-help">
        以下依 API
        實際回傳的欄位逐項顯示，包含安全分類與流程資訊。數值不換算成百分比；未回傳的選填欄位不補值。
      </p>
      <FactCheckValue :value="summary.rest" path="" />
    </section>
  </template>
  <template v-else>
    <p class="form-help">
      以下依 API 實際回傳的欄位逐項顯示。數值不換算成百分比；未回傳的選填欄位不補值。
    </p>
    <FactCheckValue :value="data" path="" />
  </template>
</template>
