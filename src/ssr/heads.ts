// <meta> 兩種寫法：name="..."（一般 SEO）與 property="..."（OG 系列）
export type MetaEntry = { name: string; content: string } | { property: string; content: string };

// 每條路由產出的 head 設定，會交給 renderHeadTags() 轉成 HTML
export interface HeadConfig {
  title: string;
  description?: string;
  meta?: MetaEntry[];
}

const SITE_NAME = "Fact Check API";

// 統一產 OG / Twitter Card meta，避免每條路由都自己寫一次
function buildOg(title: string, description: string, url: string): MetaEntry[] {
  return [
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
  ];
}

export function headForHome(origin: string): HeadConfig {
  const title = `${SITE_NAME} — 事實查核 API 使用說明`;
  const description =
    "傳入待查核文字與選填網址，取得相關查核與證據綜整。閱讀 GET／POST 呼叫範例、輸入參數、回應格式與錯誤處理說明。";
  return {
    title,
    description,
    meta: buildOg(title, description, `${origin}/`),
  };
}

export function headForAbout(origin: string): HeadConfig {
  const title = `About — ${SITE_NAME}`;
  const description = "About this template: Hono + Vue + Vue SSR on Cloudflare Workers.";
  return {
    title,
    description,
    meta: buildOg(title, description, `${origin}/about`),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 把 HeadConfig 轉成可以塞進 <head> 的 HTML 字串
export function renderHeadTags(head: HeadConfig): string {
  const parts: string[] = [
    '<meta charset="UTF-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `<title>${escapeHtml(head.title)}</title>`,
  ];
  if (head.description) {
    parts.push(`<meta name="description" content="${escapeHtml(head.description)}" />`);
  }
  for (const m of head.meta ?? []) {
    if ("name" in m) {
      parts.push(`<meta name="${escapeHtml(m.name)}" content="${escapeHtml(m.content)}" />`);
    } else {
      parts.push(
        `<meta property="${escapeHtml(m.property)}" content="${escapeHtml(m.content)}" />`,
      );
    }
  }
  return parts.join("\n    ");
}
