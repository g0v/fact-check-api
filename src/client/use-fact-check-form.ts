import { computed, ref, shallowRef } from "vue";

export function useFactCheckForm(fetcher: typeof fetch = fetch) {
  const text = ref("");
  const url = ref("");
  const pending = ref(false);
  const error = ref("");
  const result = shallowRef<{ data: unknown; raw: string; ok: boolean } | null>(null);
  const httpStatus = ref<number | null>(null);
  const requestId = ref<string | null>(null);
  const textLength = computed(() => [...text.value.trim()].length);

  async function submit() {
    if (pending.value) return;
    error.value = "";
    result.value = null;
    httpStatus.value = null;
    requestId.value = null;
    const claim = text.value.trim();
    const sourceUrl = url.value.trim();
    if (!claim || textLength.value > 10_000) {
      error.value = "請輸入 1～10,000 字的待查核文字。";
      return;
    }
    if (sourceUrl) {
      try {
        const parsed = new URL(sourceUrl);
        if (
          sourceUrl.length > 2048 ||
          !["https:", "http:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password
        )
          throw new Error();
      } catch {
        error.value = "請提供有效的 HTTP／HTTPS 網址，最多 2,048 字元，且不可包含帳號密碼。";
        return;
      }
    }
    pending.value = true;
    try {
      const response = await fetcher("/api/fact-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: claim, ...(sourceUrl ? { url: sourceUrl } : {}) }),
      });
      httpStatus.value = response.status;
      requestId.value = response.headers.get("X-Request-Id");
      const raw = await response.text();
      try {
        result.value = { data: JSON.parse(raw), raw, ok: response.ok };
      } catch {
        result.value = { data: raw, raw, ok: false };
        error.value = "伺服器回應不是有效 JSON，以下保留收到的原始內容。";
      }
    } catch {
      error.value = "無法取得完整回應，請確認網路連線後重試。";
    } finally {
      pending.value = false;
    }
  }

  return { text, url, textLength, pending, error, result, httpStatus, requestId, submit };
}
