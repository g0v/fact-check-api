import { decodeHTML } from "entities";
import { LIMITS } from "../config";
import type { Evidence } from "../types/fact-check";
import { upstreamError } from "../utils/errors";
import { readLimitedText, withTimeout, type Fetcher } from "../utils/http";
import { assertPublicDns, validatePublicUrl } from "../utils/url";

// 僅宣告本模組使用的 Workers 內建介面，實際解析由 workerd 的 HTMLRewriter 執行。
declare const HTMLRewriter: {
  new (): {
    on(
      selector: string,
      handlers: {
        element(element: {
          remove(): void;
          before(text: string): void;
          after(text: string): void;
        }): void;
      },
    ): InstanceType<typeof HTMLRewriter>;
    onDocument(handlers: {
      text(chunk: { text: string }): void;
    }): InstanceType<typeof HTMLRewriter>;
    transform(response: Response): Response;
  };
};

export async function extractHtmlText(html: string): Promise<string> {
  // 分兩次處理，確保已移除的 script 等內容不會被文字處理器收集。
  const stripped = new HTMLRewriter()
    .on("script, style, noscript, template, svg", {
      element(element) {
        element.remove();
      },
    })
    .on("p, div, br, li, tr, h1, h2, h3, section, article", {
      element(element) {
        element.before(" ");
        element.after(" ");
      },
    })
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  let text = "";
  await new HTMLRewriter()
    .onDocument({
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(stripped)
    .text();
  return text;
}

export async function fetchUrlContext(value: string, fetcher: Fetcher = fetch): Promise<Evidence> {
  try {
    return await withTimeout(async (signal) => {
      let url = validatePublicUrl(value);
      const visited = new Set<string>();
      for (let redirects = 0; redirects <= LIMITS.redirects; redirects++) {
        if (visited.has(url.href)) throw new Error("網址重新導向形成循環。");
        visited.add(url.href);
        await assertPublicDns(url, fetcher, signal);
        const response = await fetcher(url, {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { Accept: "text/html, text/plain;q=0.9", "User-Agent": "FactCheckAPI/0.1" },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location) throw new Error("重新導向缺少網址。");
          url = validatePublicUrl(new URL(location, url).href);
          continue;
        }
        const contentType = response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase();
        const length = Number(response.headers.get("content-length") ?? 0);
        const charset = /charset\s*=\s*"?([^;"\s]+)/i
          .exec(response.headers.get("content-type") ?? "")?.[1]
          .toLowerCase();
        if (
          !response.ok ||
          !["text/html", "text/plain"].includes(contentType ?? "") ||
          length > LIMITS.urlBytes ||
          (charset && !["utf-8", "utf8", "us-ascii"].includes(charset))
        ) {
          await response.body?.cancel();
          throw new Error("網址回應的狀態、類型、編碼或大小不受支援。");
        }
        const body = await readLimitedText(response.body, LIMITS.urlBytes, signal);
        const text = (contentType === "text/html" ? decodeHTML(await extractHtmlText(body)) : body)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, LIMITS.urlText);
        if (!text) throw new Error("網址沒有可供查核的文字。");
        return {
          source: "provided-url",
          reliability: "user-provided",
          evidenceText: text,
          sourceUrl: url.href,
        };
      }
      throw new Error("網址重新導向次數過多。");
    }, LIMITS.fetchTimeoutMs);
  } catch {
    throw upstreamError("url");
  }
}
