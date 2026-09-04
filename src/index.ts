import { Hono } from 'hono'
import HomeView from './views/Home.vue'
import AboutView from './views/About.vue'
import { renderPage } from './ssr/render'
import { headForHome, headForAbout } from './ssr/heads'

// Cloudflare Worker 綁定型別；ASSETS 在 wrangler.jsonc 對應到 ./public/
type Bindings = {
  ASSETS?: {
    fetch: (request: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }
}

const app = new Hono<{ Bindings: Bindings }>()

// 純 JSON / 文字 API：直接回傳，不走 SSR
app.get('/api/hello', (c) => c.text('Hello World!'))

// SSR 路由：每條路由把 props 與 head 交給 renderPage 產出完整 HTML
app.get('/', async (c) => {
  const origin = new URL(c.req.url).origin
  const html = await renderPage(HomeView, {}, headForHome(origin))
  return c.html(html)
})

app.get('/about', async (c) => {
  const origin = new URL(c.req.url).origin
  const html = await renderPage(AboutView, {}, headForAbout(origin))
  return c.html(html)
})

// 其他未命中的請求 → 交給 ASSETS 處理（favicon、styles.css 等靜態檔）
app.get('*', async (c) => {
  if (!c.env.ASSETS) return c.notFound()
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
