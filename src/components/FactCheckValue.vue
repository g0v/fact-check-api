<script setup lang="ts">
import { computed } from "vue";
import { fieldInfo, safeSourceLink, valueLabel } from "../client/fact-check-fields";

const props = defineProps<{ value: unknown; path: string }>();
const entries = computed(() =>
  props.value !== null && typeof props.value === "object" && !Array.isArray(props.value)
    ? Object.entries(props.value)
    : null,
);
const link = computed(() => safeSourceLink(props.path, props.value));
const label = computed(() => valueLabel(props.path, props.value));
const childPath = (key: string) => (props.path ? `${props.path}.${key}` : key);
</script>

<template>
  <template v-if="value === null"
    ><span class="result-empty">null（沒有值，並非 0）</span></template
  >
  <template v-else-if="Array.isArray(value)">
    <p v-if="value.length === 0" class="result-empty">[]（空陣列）</p>
    <ol v-else class="result-items">
      <li v-for="(item, index) in value" :key="index">
        <FactCheckValue :value="item" :path="`${path}[]`" />
      </li>
    </ol>
  </template>
  <template v-else-if="entries">
    <p v-if="entries.length === 0" class="result-empty">{}（空物件）</p>
    <dl v-else class="result-fields">
      <div v-for="[key, item] in entries" :key="key" class="result-field">
        <dt>
          {{ fieldInfo(childPath(key)).label }} <code>{{ key }}</code>
        </dt>
        <dd>
          <p class="field-description">{{ fieldInfo(childPath(key)).description }}</p>
          <FactCheckValue :value="item" :path="childPath(key)" />
        </dd>
      </div>
    </dl>
  </template>
  <template v-else>
    <a v-if="link" :href="link" target="_blank" rel="noopener noreferrer" class="result-value">{{
      value
    }}</a>
    <span v-else-if="value === ''" class="result-empty">""（空字串）</span>
    <span v-else class="result-value" :class="{ 'result-number': typeof value === 'number' }">{{
      String(value)
    }}</span>
    <span v-if="label" class="result-label">{{ label }}</span>
  </template>
</template>
