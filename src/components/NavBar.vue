<script setup lang="ts">
defineProps<{ current?: string }>();
</script>

<template>
  <nav class="navbar" aria-label="主要導覽">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">✓</span>Fact Check API</a>
    <div class="nav-links">
      <a
        href="/"
        :class="{ active: current === 'home' }"
        :aria-current="current === 'home' ? 'page' : undefined"
        >API 文件</a
      >
      <a
        href="/about"
        :class="{ active: current === 'about' }"
        :aria-current="current === 'about' ? 'page' : undefined"
        >關於樣板</a
      >
      <a href="https://github.com/g0v/fact-check-api">GitHub <span aria-hidden="true">↗</span></a>
    </div>
  </nav>
</template>
