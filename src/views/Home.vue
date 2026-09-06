<script setup lang="ts">
import NavBar from "../components/NavBar.vue";

const props = defineProps<{ origin: string }>();
const claim = "非學校型態學生，國中小以下目前沒有普遍補助";
const endpoint = `${props.origin}/api/fact-check`;
const shellEndpoint = `'${endpoint.replace(/'/g, "'\\''")}'`;
const postExample = `curl ${shellEndpoint} \\
  -H 'Content-Type: application/json' \\
  --data '${JSON.stringify({ text: claim })}'`;
const getExample = `curl --get ${shellEndpoint} \\
  --data-urlencode 'text=${claim}'`;
const urlExample = `curl --get ${shellEndpoint} \\
  --data-urlencode 'text=${claim}' \\
  --data-urlencode 'url=https://civic.vtaiwan.tw/issues/7'`;
const responseExample = JSON.stringify(
  {
    text: claim,
    status: "completed",
    moderation: { decision: "allow", categories: [] },
    factuality: 0.5,
    confidence: 0.1,
    verdict: "insufficient_evidence",
    related_checks: [],
    feedback: "目前沒有足夠相關證據，無法判定這項主張。",
    meta: {
      request_id: "example-request-id",
      cofacts_candidates: 0,
      cofacts_relevant: 0,
      cofacts_human_checks: 0,
      cofacts_ai_checks: 0,
      url_context_used: false,
      warnings: [],
    },
  },
  null,
  2,
);
const verdicts = [
  ["supported", "證據支持"],
  ["mostly_supported", "證據大致支持"],
  ["mixed", "支持與反駁的證據並存"],
  ["mostly_refuted", "證據大致反駁"],
  ["refuted", "證據反駁"],
  ["insufficient_evidence", "證據不足，無法判定"],
];
</script>

<template>
  <a class="skip-link" href="#quickstart">跳至使用說明</a>
  <NavBar current="home" />
  <main class="docs-page">
    <header class="hero">
      <div>
        <p class="eyebrow">開放原始碼 · 事實查核 API <span class="version-tag">MVP</span></p>
        <h1>把事實查核，<br />接進你的應用。</h1>
        <p class="hero-description">
          送入一段待查核文字，取得相關查核、證據綜整與結構化 JSON
          結果。也能附上來源網址，補充查核背景。
        </p>
        <div class="hero-actions">
          <a class="button" href="#quickstart">開始串接 <span aria-hidden="true">↗</span></a>
          <a class="text-link" href="#response">閱讀回應格式 <span aria-hidden="true">↓</span></a>
        </div>
      </div>
      <div class="endpoint-panel" aria-label="API 端點一覽">
        <p class="panel-label">一個查核端點，兩種呼叫方式</p>
        <div class="endpoint-row"><span class="method">POST</span><code>/api/fact-check</code></div>
        <p class="endpoint-note">以 JSON 傳入文字與選填網址。</p>
        <div class="endpoint-row">
          <span class="method method-get">GET</span><code>/api/fact-check</code>
        </div>
        <p class="endpoint-note">以 query string 傳入相同參數。</p>
        <div class="endpoint-footer">
          <span>服務狀態</span
          ><a href="/health"><code>GET /health</code> <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </header>

    <div class="docs-layout">
      <aside class="docs-sidebar">
        <nav aria-label="本頁目錄">
          <p class="eyebrow">使用指南</p>
          <a href="#quickstart"><span>01</span>開始呼叫</a>
          <a href="#parameters"><span>02</span>輸入參數</a>
          <a href="#response"><span>03</span>讀懂回應</a>
          <a href="#errors"><span>04</span>狀態與錯誤</a>
          <a href="#pipeline"><span>05</span>查核如何進行</a>
          <a href="#self-host"><span>06</span>自行架設</a>
        </nav>
      </aside>

      <div class="docs-content">
        <section id="quickstart" class="doc-section" aria-labelledby="quickstart-title">
          <p class="section-number">01 / 開始呼叫</p>
          <h2 id="quickstart-title">第一個查核請求</h2>
          <p>
            複製下方指令，在終端機呼叫本站 API。將
            <code>text</code> 換成你要查核的具體主張；呼叫前，服務維運者需先完成模型設定。
          </p>
          <div class="code-heading">
            <span><span class="method">POST</span> 傳入 JSON</span><span>cURL</span>
          </div>
          <pre tabindex="0" aria-label="POST 查核指令"><code>{{ postExample }}</code></pre>
          <p class="note">
            內容較長或包含敏感資訊時，建議使用 POST，避免文字出現在網址歷史或 access
            log。請勿在呼叫端傳入 OpenRouter 金鑰。
          </p>
          <details class="code-details">
            <summary>使用 GET 呼叫</summary>
            <p>使用 <code>--data-urlencode</code> 編碼中文、空白及特殊字元。</p>
            <pre tabindex="0" aria-label="GET 查核指令"><code>{{ getExample }}</code></pre>
          </details>
          <details class="code-details">
            <summary>附上 URL，補充查核背景</summary>
            <p>
              GET 與 POST 都接受選填的 <code>url</code>。以下示範 GET；POST 則在 JSON 加入相同欄位。
            </p>
            <pre tabindex="0" aria-label="附帶 URL 的查核指令"><code>{{ urlExample }}</code></pre>
          </details>
        </section>

        <section id="parameters" class="doc-section" aria-labelledby="parameters-title">
          <p class="section-number">02 / 輸入參數</p>
          <h2 id="parameters-title">一段文字，一個選填網址</h2>
          <div class="table-scroll" tabindex="0" role="region" aria-label="輸入參數表">
            <table>
              <thead>
                <tr>
                  <th scope="col">欄位</th>
                  <th scope="col">必填</th>
                  <th scope="col">格式與限制</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row"><code>text</code></th>
                  <td>是</td>
                  <td>
                    <code>string</code>，去除首尾空白後不可為空，最多 10,000 字（Unicode code
                    point）。
                  </td>
                </tr>
                <tr>
                  <th scope="row"><code>url</code></th>
                  <td>否</td>
                  <td>
                    公開 HTTP／HTTPS 網址，最多 2,048 個 UTF-16 code
                    unit；不可包含帳號密碼或指向內網。
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            POST 使用 <code>Content-Type: application/json</code>，請求本文上限為 128,000
            bytes。沒有網址時請省略 <code>url</code>，不要傳空字串或 <code>null</code>。
          </p>
          <div class="callout">
            <strong>網址提供背景，不代表可信。</strong>
            <p>
              支援 HTML 與純文字頁面，不執行網頁 JavaScript。網址抓取失敗時，Cofacts
              查核仍會繼續，並在回應保留警告。
            </p>
          </div>
        </section>

        <section id="response" class="doc-section" aria-labelledby="response-title">
          <p class="section-number">03 / 讀懂回應</p>
          <h2 id="response-title">判斷結果，也保留證據脈絡</h2>
          <p>
            以下是「證據不足」的格式示例，並非對範例主張的實際查核結果。<code>completed</code>
            表示流程完成，仍可能得到 <code>insufficient_evidence</code>。
          </p>
          <div class="code-heading"><span>回應示例 · 證據不足</span><span>JSON</span></div>
          <pre
            class="response-code"
            tabindex="0"
            aria-label="查核回應 JSON 示範"
          ><code>{{ responseExample }}</code></pre>
          <dl class="field-list">
            <div>
              <dt><code>factuality</code></dt>
              <dd>
                0～1，表示證據支持主張的程度。它不是主張為真的機率；無證據時的 0.5 表示無法判定。
              </dd>
            </div>
            <div>
              <dt><code>confidence</code></dt>
              <dd>0～1，表示判斷所依據的證據是否充分、可靠且一致。應與 factuality 一起閱讀。</dd>
            </div>
            <div>
              <dt><code>feedback</code></dt>
              <dd>繁體中文說明，補充證據限制、適用範圍與需要進一步查證之處。</dd>
            </div>
            <div>
              <dt><code>related_checks</code></dt>
              <dd>
                相關查核陣列，以 <code>cofacts_human</code>／<code>cofacts_ai</code> 區分人工與 AI
                回覆。每筆包含查核文字與 Cofacts 原文 <code>url</code>；有引文時另附
                <code>reference_url</code>／<code>reference_urls</code>。
              </dd>
            </div>
            <div>
              <dt><code>meta</code></dt>
              <dd>
                包含 request ID、候選及證據數量、是否使用 URL 背景，以及
                <code>warnings</code> 警告。
              </dd>
            </div>
          </dl>
          <h3>六種判斷結果</h3>
          <div class="verdict-list">
            <div v-for="[value, label] in verdicts" :key="value">
              <code>{{ value }}</code
              ><span>{{ label }}</span>
            </div>
          </div>
          <p class="note">
            <strong>兩種分數各有用途：</strong><code>retrieval_score</code> 只是 Cofacts
            搜尋排序；<code>relevance_score</code> 是 0～1
            的語意相關程度。兩者都不代表真假，不能直接換算 factuality。
          </p>
        </section>

        <section id="errors" class="doc-section" aria-labelledby="errors-title">
          <p class="section-number">04 / 狀態與錯誤</p>
          <h2 id="errors-title">先看 HTTP，再看 status</h2>
          <p>
            HTTP 200 包含以下三種情況。串接時，請一併檢查 JSON 的 <code>status</code> 與
            <code>meta.warnings</code>。
          </p>
          <dl class="field-list">
            <div>
              <dt><code>completed</code></dt>
              <dd>查核流程完成；證據不足也是有效結果。</dd>
            </div>
            <div>
              <dt><code>partial</code></dt>
              <dd>部分上游服務失敗，根據仍可取得的證據完成綜整。警告會列出失敗階段。</dd>
            </div>
            <div>
              <dt><code>blocked</code></dt>
              <dd>
                安全層停止查核；factuality、confidence 與 verdict 為
                <code>null</code>，related_checks 為空陣列。
              </dd>
            </div>
          </dl>
          <p>
            安全分類 <code>allow</code> 會繼續；<code>review</code>
            也會繼續，但保留旗標。引用待查言論、新聞、公共政策及學術討論等情境，會納入查核例外考量。
          </p>
          <div class="table-scroll" tabindex="0" role="region" aria-label="HTTP 錯誤狀態表">
            <table>
              <thead>
                <tr>
                  <th scope="col">HTTP</th>
                  <th scope="col">error</th>
                  <th scope="col">處理方式</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">400</th>
                  <td><code>INVALID_INPUT</code></td>
                  <td>依 message 修正文字、網址、JSON 格式或請求大小。</td>
                </tr>
                <tr>
                  <th scope="row">413</th>
                  <td><code>PAYLOAD_TOO_LARGE</code></td>
                  <td>已宣告的請求本文過大，請縮短內容。</td>
                </tr>
                <tr>
                  <th scope="row">502</th>
                  <td><code>UPSTREAM_UNAVAILABLE</code></td>
                  <td>必要上游服務無法使用；依 stage 確認階段，稍後重試。</td>
                </tr>
                <tr>
                  <th scope="row">500</th>
                  <td><code>INTERNAL_ERROR</code></td>
                  <td>服務發生未預期錯誤，請提供 request_id 協助排查。</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            Safeguard 或 Gemma 失敗回 502。Cofacts 搜尋或語意初篩失敗時，只有已成功取得 URL
            文字才能繼續並回 partial，否則回 502。單篇詳細證據失敗則保留其他資料。
          </p>
          <p class="note">
            查核回應附有 <code>X-Request-Id</code> 與 <code>Cache-Control: no-store</code>。<code
              >GET /health</code
            >
            只確認服務能回應，不代表外部模型與資料來源皆正常。
          </p>
        </section>

        <section id="pipeline" class="doc-section" aria-labelledby="pipeline-title">
          <p class="section-number">05 / 查核如何進行</p>
          <h2 id="pipeline-title">先找相關證據，再綜整判斷</h2>
          <ol class="pipeline-list">
            <li>
              <span class="step-index">1</span>
              <div>
                <h3>安全分類</h3>
                <p>OpenRouter Safeguard 判斷內容是否能進入查核流程。</p>
              </div>
            </li>
            <li>
              <span class="step-index">2</span>
              <div>
                <h3>搜尋候選內容</h3>
                <p>Cofacts 召回最多 15 篇候選文章；選填 URL 的抓取在此階段平行進行。</p>
              </div>
            </li>
            <li>
              <span class="step-index">3</span>
              <div>
                <h3>篩出真正相關的文章</h3>
                <p>Workers AI gpt-oss-20b 批次判斷語意相關性，最多保留 5 篇。此階段不判真假。</p>
              </div>
            </li>
            <li>
              <span class="step-index">4</span>
              <div>
                <h3>取得詳細證據</h3>
                <p>只讀取通過初篩文章的人工與 AI 查核回覆，並保留來源連結。</p>
              </div>
            </li>
            <li>
              <span class="step-index">5</span>
              <div>
                <h3>綜整結果</h3>
                <p>Gemma 根據整理後的證據產生判斷；沒有足夠證據時，回傳證據不足。</p>
              </div>
            </li>
          </ol>
        </section>

        <section id="self-host" class="doc-section self-host" aria-labelledby="self-host-title">
          <p class="section-number">06 / 自行架設</p>
          <h2 id="self-host-title">在自己的服務中使用</h2>
          <p>
            本專案以 Cloudflare Workers 與 Hono 執行。維運者需設定
            <code>OPENROUTER_API_KEY</code>，並啟用 Workers AI 的 <code>AI</code> binding；Cofacts
            使用公開 GraphQL，無須 app ID 或 secret。
          </p>
          <a class="text-link" href="https://github.com/g0v/fact-check-api#readme"
            >查看安裝與開發指南 <span aria-hidden="true">↗</span></a
          >
        </section>
      </div>
    </div>
    <footer class="site-footer">
      <span>Fact Check API · 以證據為依據，保留不確定性。</span
      ><a href="https://github.com/g0v/fact-check-api/blob/main/design/fact_check_MVP_plan.md"
        >工程藍圖 ↗</a
      >
    </footer>
  </main>
</template>
