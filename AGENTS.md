# AGENTS.md

## 適用範圍

本文件適用於整個 repository。若更深層目錄新增自己的 `AGENTS.md`，以距離工作檔案較近的規則為準；使用者在當次請求中的明確指示優先於本文件。

## 專案背景

- 本專案是以 Cloudflare Workers 與 Hono 建立的事實查核 API MVP。
- `design/fact_check_MVP_plan.md` 是目前架構與 MVP 驗收目標的主要依據。
- 查核 pipeline 的角色必須維持分離：OpenRouter Safeguard 負責安全分類、Cofacts 負責候選召回、Workers AI `gpt-oss-20b` 負責語意相關性初篩、Gemma 負責 evidence synthesis。
- Cofacts 的 retrieval `_score` 不得當成百分比、機率、relevance 或 factuality；`retrievalScore` 與 `relevanceScore` 必須分開。
- 除非使用者明確要求，現階段先不移除或重寫既有 Vue SSR scaffold；新增查核功能時應與現有主程式變更分開處理。

## 語言與命名

- 與使用者溝通、文件、註解及錯誤訊息全程使用繁體中文。
- 程式碼中的變數、函式、型別、檔名及 API 欄位命名維持英文，並沿用既有命名風格。
- 不要把 plan 裡的待辦事項誤當成當次請求；只有使用者要求的工作才執行。

## 工作權限與邊界

- 可以直接修改程式碼、設定、文件與測試。
- 可以直接安裝依賴、執行檢查與測試，也可以建立 commit。
- push、建立或更新 PR、部署到任何環境前，必須先向使用者詢問並取得同意。
- 不使用 `git reset --hard`、`git checkout --` 或其他會丟失使用者變更的操作；保留與當次任務無關的工作區修改。
- 不在未被要求時刪除檔案、重寫主程式或進行大規模 migration。

## Secret 與敏感資料

- 不得讀取、輸出、複製、記錄或提交任何 API key、token、password、cookie、私鑰或其他 credential。
- 不要讀取 `.dev.vars`、`.env` 等 secret 檔案的內容；需要確認設定時，只檢查檔案是否存在或使用不會暴露值的方式驗證。
- README、範例設定及測試只能使用 placeholder，例如 `your-openrouter-api-key`。
- MVP 的 secret 名稱以 `OPENROUTER_API_KEY` 為準；不得在 log 或錯誤訊息中洩漏其值。

## 固定驗證流程

每次完成程式碼、設定、依賴或文件修改前，固定執行以下指令：

```bash
vp run check
vp run build
vp test
```

- 三個指令都必須執行；即使目前沒有測試檔，也要執行 `vp test` 並在交付摘要中說明結果。
- 若檢查失敗，先修正與當次修改相關的問題；無法修正時，明確回報失敗指令、原因與未完成項目，不可假裝驗證成功。
- 不要因為驗證工具自動格式化而忽略其產生的必要變更；檢查 diff 後再交付。

## Git 及交付

- commit 可以直接建立，但只提交與當次任務相關的檔案。
- commit message 使用英文、簡潔描述實際變更；除非使用者另有要求，不執行 push、PR 或部署。
- 交付時以繁體中文摘要變更、驗證結果、已知風險及需要使用者決定的事項。
