import { createSSRApp, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { renderHeadTags, type HeadConfig } from './heads'

// 把 Vue 元件 + props + head 組成完整 HTML 字串
// 流程：createSSRApp(元件, props) → renderToString(產出 body) → 套上 head 模板
export async function renderPage(
  component: Component,
  props: Record<string, unknown>,
  head: HeadConfig,
): Promise<string> {
  const app = createSSRApp(component, props)
  const bodyHtml = await renderToString(app)
  const headTags = renderHeadTags(head)
  return `<!doctype html>
<html lang="zh-Hant">
  <head>
    ${headTags}
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <div id="app">${bodyHtml}</div>
  </body>
</html>`
}
