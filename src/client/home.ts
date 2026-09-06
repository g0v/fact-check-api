import { createSSRApp } from "vue";
import FactCheckForm from "../components/FactCheckForm.vue";

// 僅啟用表單區塊的互動，首頁使用說明仍由既有 SSR 輸出。
const container = document.getElementById("fact-check-app");
if (container) createSSRApp(FactCheckForm).mount(container);
