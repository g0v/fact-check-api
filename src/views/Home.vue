<script setup lang="ts">
import NavBar from '../components/NavBar.vue'
</script>

<template>
  <NavBar current="home" />
  <main class="container">
    <h1>Hono + Vue SSR Template</h1>
    <p>
      A minimal Cloudflare Workers template using
      <strong>Hono</strong> for routing and
      <strong>Vue 3 SSR</strong> for rendering.
    </p>
    <ul>
      <li><a href="/about">About this template</a></li>
      <li><a href="/api/hello">/api/hello — JSON API demo</a></li>
    </ul>
  </main>
</template>
