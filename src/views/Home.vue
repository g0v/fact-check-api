<script setup lang="ts">
import NavBar from "../components/NavBar.vue";
import FactCheckForm from "../components/FactCheckForm.vue";

const props = defineProps<{ origin: string }>();
const claim = "非學校型態學生，國中小以下目前沒有普遍補助";
const endpoint = `${props.origin}/api/fact-check`;
const shellEndpoint = `'${endpoint.replace(/'/g, "'\\''")}'`;
const postExample = `// 第一次請求會回 402；用錢包依 PAYMENT-REQUIRED 產生簽章
const paymentSignature = await wallet.createPaymentSignature(/* PAYMENT-REQUIRED */);
const response = await fetch("/api/fact-check", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "PAYMENT-SIGNATURE": paymentSignature
  },
  body: JSON.stringify({
    text: "${claim}"
  })
});
const result = await response.json();
console.log(result);`;
const getExample = `curl --get ${shellEndpoint} \\
  --data-urlencode 'text=${claim}'`;
const urlExample = `curl --get ${shellEndpoint} \\
  --data-urlencode 'text=${claim}' \\
  --data-urlencode 'url=https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=A0000001'`;
const responseExample = JSON.stringify(
  {
    text: claim,
    status: "completed",
    moderation: { decision: "allow", categories: [] },
    factuality: 0.7,
    confidence: 0.4,
    verdict: "mostly_supported",
    related_checks: [],
    feedback: "查無相關查核資料，以下為常識判斷：此主張與常見制度描述大致相符，請自行查證。",
    meta: {
      request_id: "example-request-id",
      cofacts_candidates: 0,
      cofacts_relevant: 0,
      cofacts_human_checks: 0,
      cofacts_ai_checks: 0,
      url_context_used: false,
      url_context_allowlisted: false,
      no_relevant_evidence: true,
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
  <a class="skip-link" href="#try-it">跳至查核表單</a>
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
          <a class="button" href="#try-it">立即查核 <span aria-hidden="true">↓</span></a>
          <a class="text-link" href="#response">閱讀回應格式 <span aria-hidden="true">↓</span></a>
        </div>
      </div>
      <div class="endpoint-panel" aria-label="API 端點一覽">
        <p class="panel-label">付費查核與免費入口</p>
        <div class="endpoint-row"><span class="method">POST</span><code>/api/fact-check</code></div>
        <p class="endpoint-note">
          x402 付費 API：verify 通過後轉送 fact-check-core，成功回應才 settle（每次 0.05 USDC）。
        </p>
        <div class="endpoint-row">
          <span class="method method-get">GET</span><code>/api/fact-check</code>
        </div>
        <p class="endpoint-note">同樣需要付款；query string 會轉成 core 的 POST JSON。</p>
        <div class="endpoint-row"><span class="method">POST</span><code>/api/demo</code></div>
        <p class="endpoint-note">
          首頁使用的免費入口，保留 Origin guard、CORS 與 IP 限流（每 IP 60 秒一次）。
        </p>
        <div class="endpoint-footer">
          <span>服務狀態</span
          ><a href="/health"><code>GET /health</code> <span aria-hidden="true">↗</span></a>
        </div>
      </div>
    </header>

    <div id="fact-check-app"><FactCheckForm /></div>

    <div class="docs-layout">
      <aside class="docs-sidebar">
        <nav aria-label="本頁目錄">
          <p class="eyebrow">使用指南</p>
          <a href="#quickstart"><span>01</span>開始呼叫</a>
          <a href="#parameters"><span>02</span>輸入參數</a>
          <a href="#response"><span>03</span>讀懂回應</a>
          <a href="#errors"><span>04</span>狀態與錯誤</a>
          <a href="#payment"><span>05</span>x402 付款流程</a>
          <a href="#self-host"><span>06</span>自行架設</a>
        </nav>
      </aside>

      <div class="docs-content">
        <section id="quickstart" class="doc-section" aria-labelledby="quickstart-title">
          <p class="section-number">01 / 開始呼叫</p>
          <h2 id="quickstart-title">第一個查核請求</h2>
          <p>
            `/api/fact-check` 是 x402 付費 API，每次查核收取 0.05 USDC。第一次呼叫會回
            <code>402</code>；請用支援 x402 的錢包依 <code>PAYMENT-REQUIRED</code> 產生付款簽章，
            再以 <code>PAYMENT-SIGNATURE</code>（或舊版 <code>X-PAYMENT</code>）重試相同請求。
            首頁互動表單則使用下方的免費 <code>/api/demo</code>，不需要錢包。
          </p>
          <div class="code-heading">
            <span><span class="method">POST</span> JSON 請求</span><span>JavaScript</span>
          </div>
          <pre tabindex="0" aria-label="x402 POST 查核範例"><code>{{ postExample }}</code></pre>
          <p class="note">
            付費端點預設使用 Base mainnet（<code>eip155:8453</code>）與 0.05 USDC；測試時可切換 Base
            Sepolia（<code>eip155:84532</code>）。付款簽章由錢包或 x402 client
            產生，請勿在瀏覽器程式碼中放入 facilitator secret。
          </p>
          <p class="note">
            付費端點允許寬鬆跨來源 CORS，預檢允許 <code>PAYMENT-SIGNATURE</code> 與
            <code>X-PAYMENT</code>。免費 <code>/api/demo</code> 仍只接受本站與既有允許清單來源，
            並保留 Origin guard、CORS 與 IP 限流；預設每個 IP 每 60 秒一次，可由
            <code>RATE_LIMIT_WINDOW_MS</code> 調整。
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
            <strong>付款 verify 通過後才轉送 fact-check-core；成功回應才會 settle。</strong>
            <p>
              本 Worker 只負責輸入基本格式與公開網址驗證，不執行查核模型。GET 的 query string 會轉成
              core 所需的 POST JSON；核心回應本文與 <code>X-Request-Id</code>、
              <code>Cache-Control</code>、<code>X-Fact-Check-Cache</code> 等標頭會原樣回傳。
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
          <h2 id="errors-title">先看 HTTP，再看核心回應</h2>
          <p>
            付款放行後，查核 JSON 與核心的狀態欄位會原樣轉送；服務自身只負責付款與 proxy。
            所有回應都附 <code>X-Request-Id</code>，並維持 <code>Cache-Control: no-store</code>。
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
                  <th scope="row">402</th>
                  <td><code>PAYMENT_REQUIRED</code></td>
                  <td>依 PAYMENT-REQUIRED 付款，帶 PAYMENT-SIGNATURE 重試。</td>
                </tr>
                <tr>
                  <th scope="row">400</th>
                  <td><code>INVALID_INPUT</code></td>
                  <td>修正 JSON、文字或網址後重試。</td>
                </tr>
                <tr>
                  <th scope="row">413</th>
                  <td><code>PAYLOAD_TOO_LARGE</code></td>
                  <td>縮短請求本文。</td>
                </tr>
                <tr>
                  <th scope="row">502</th>
                  <td><code>UPSTREAM_UNAVAILABLE</code></td>
                  <td>service binding 或 core 暫時不可用；這次錯誤不會結算付款，詳見 README。</td>
                </tr>
                <tr>
                  <th scope="row">500</th>
                  <td><code>INTERNAL_ERROR</code></td>
                  <td>提供 request ID 協助排查。</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="note">
            `/api/demo` 另有免費入口的 <code>FORBIDDEN_ORIGIN</code> 與 <code>RATE_LIMITED</code>；
            這些守護不套用到 x402 付費端點。
          </p>
        </section>

        <section id="payment" class="doc-section" aria-labelledby="payment-title">
          <p class="section-number">05 / x402 付款流程</p>
          <h2 id="payment-title">先驗證，再轉送；成功才結算</h2>
          <ol class="pipeline-list">
            <li>
              <span class="step-index">1</span>
              <div>
                <h3>收到 402</h3>
                <p>第一次呼叫不帶付款，服務回傳 PAYMENT-REQUIRED 與繁體中文付款說明。</p>
              </div>
            </li>
            <li>
              <span class="step-index">2</span>
              <div>
                <h3>使用錢包付款</h3>
                <p>預設在 Base mainnet 以 USDC 支付 0.05；測試可切換 Base Sepolia。</p>
              </div>
            </li>
            <li>
              <span class="step-index">3</span>
              <div>
                <h3>帶簽章重試</h3>
                <p>把 PAYMENT-SIGNATURE（或 X-PAYMENT）附在相同 GET／POST 請求重試。</p>
              </div>
            </li>
            <li>
              <span class="step-index">4</span>
              <div>
                <h3>驗證、轉送，再結算</h3>
                <p>
                  facilitator verify 成功後才透過 service binding 送到 fact-check-core；handler 回應
                  <code>&lt;400</code>（本 API 通常為 2xx）才呼叫 settle。回應
                  <code>&gt;=400</code> 時不結算，錯誤直接回客戶端。
                </p>
              </div>
            </li>
            <li>
              <span class="step-index">5</span>
              <div>
                <h3>保留核心回應</h3>
                <p>
                  核心回應本文與 X-Request-Id、Cache-Control、X-Fact-Check-Cache 等標頭原樣回傳。
                </p>
              </div>
            </li>
          </ol>
          <p class="note">
            x402 沒有 JWT cookie 通行證；每個付費 API 請求都要 verify。core 回
            <code>&gt;=400</code> 或 fetch 失敗轉 502 時不結算；core 回 2xx
            但內容為錯誤仍可能結算，settle 網路失敗則需另外確認付款狀態。
          </p>
        </section>

        <section id="self-host" class="doc-section self-host" aria-labelledby="self-host-title">
          <p class="section-number">06 / 自行架設</p>
          <h2 id="self-host-title">設定 facilitator 與 core binding</h2>
          <p>
            本專案以 Cloudflare Workers、Hono 與 <code>@x402/hono</code> 執行。維運者需設定
            <code>PAY_TO</code>、<code>X402_NETWORK</code>、<code>X402_PRICE</code> 與
            <code>FACILITATOR_URL</code>，並在 <code>wrangler.jsonc</code> 維持
            <code>FACT_CHECK_CORE</code> service binding。Base mainnet 上線前請準備 production
            facilitator；公開 x402.org facilitator 僅適合 Base Sepolia 測試。
          </p>
          <a class="text-link" href="https://github.com/g0v/fact-check-api#readme"
            >查看安裝與付款設定指南 <span aria-hidden="true">↗</span></a
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
