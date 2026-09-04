# hono-vue-ssr-template

**EN:** Minimal Cloudflare Workers template using **Hono** for routing and **Vue 3 SSR** for rendering. No D1 / R2 / KV / AI bindings — just a worker that server-renders Vue components and serves a few static assets.

**中文：**極簡的 Cloudflare Workers 範本：路由用 **Hono**、畫面用 **Vue 3 SSR**。不含 D1 / R2 / KV / AI 等綁定，僅以 Worker 做 Vue 元件伺服端渲染，並提供少數靜態資源。

## Routes / 路由

| Route | EN | 中文 |
| ----- | -- | ---- |
| `/` | Home page (SSR) | 首頁（SSR） |
| `/about` | About page (SSR) | 關於頁（SSR） |
| `/api/hello` | Returns `Hello World!` | 回傳 `Hello World!` |
| `*` | Falls back to the `ASSETS` binding (`./public/`) | 其餘路徑交給 `ASSETS` 綁定（`./public/`） |

## Stack / 技術棧

**EN**

- [Hono](https://hono.dev) — the worker / router
- [Vue 3](https://vuejs.org) + `@vue/server-renderer` — SSR
- [Vite](https://vite.dev) + `@vitejs/plugin-vue` + `@cloudflare/vite-plugin` — build / dev
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) — deploy

**中文**

- [Hono](https://hono.dev) — Worker 與路由
- [Vue 3](https://vuejs.org) + `@vue/server-renderer` — 伺服端渲染
- [Vite](https://vite.dev) + `@vitejs/plugin-vue` + `@cloudflare/vite-plugin` — 建置與本機開發
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) — 部署

## Layout / 目錄結構

```
src/
├── index.ts             # Hono worker entry — defines all routes / Worker 入口，定義所有路由
├── ssr/
│   ├── render.ts        # createSSRApp + renderToString → full HTML page / 產出完整 HTML
│   └── heads.ts         # per-route <title> / OG meta builders / 各路由的 <title> 與 OG meta
├── views/
│   ├── Home.vue
│   └── About.vue
└── components/
    └── NavBar.vue
public/                  # static assets, served via ASSETS binding / 靜態資源，經 ASSETS 提供
├── styles.css
└── favicon.svg
```

## Develop / 開發

```bash
npm install
npm run dev          # vite dev — runs the worker locally with HMR
                   # Vite 開發模式：本機跑 Worker，含 HMR
```

## Deploy / 部署

```bash
npm run deploy       # vite build + wrangler deploy
                   # Vite 建置 + wrangler deploy
```

## Adding a route / 新增路由

**EN**

1. Create a `.vue` file in `src/views/`.
2. Add a `headForX(...)` function in `src/ssr/heads.ts`.
3. Wire a route in `src/index.ts`:

   ```ts
   app.get('/foo', async (c) => {
     const origin = new URL(c.req.url).origin
     const html = await renderPage(FooView, {}, headForFoo(origin))
     return c.html(html)
   })
   ```
**中文**

1. 在 `src/views/` 新增 `.vue` 檔。
2. 在 `src/ssr/heads.ts` 新增 `headForX(...)` 函式。
3. 在 `src/index.ts` 接上路由（見上方程式片段）。

## Dynamic HEAD / 動態 `<head>`

**EN:** Each route builds a `HeadConfig` (title + meta) before rendering. Add more `og:` / `twitter:` tags or extend `HeadConfig` as needed.

**中文：**每個路由在渲染前會組出 `HeadConfig`（標題與 meta）。可依需求擴充 `og:` / `twitter:` 標籤或延伸 `HeadConfig`。

## License / 授權

**EN:** MIT — see [LICENSE](./LICENSE).

**中文：**MIT — 詳見 [LICENSE](./LICENSE)。
