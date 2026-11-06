import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// 构建版本号：源码 mtime + 内容 hash 前缀——页面显示，一眼对上"我访问的是不是最新"
const BUILD_TAG = "b" + Date.now().toString(36);

export default defineConfig({
  // 零配置 base_path：资源全相对引用（./assets/..），挂任意前缀由浏览器按地址栏解析
  // （code-server 4.144 serverBasePath:"." 同款姿势），server 不再做前缀重写
  base: "./",
  define: { __BUILD_TAG__: JSON.stringify(BUILD_TAG) },
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // npmmirror 同步的 mermaid 链损坏（parser 缺 .mjs、cytoscape 截断）；
      // 聊天场景不渲染 mermaid 图，统一 stub（打包期替换，避免运行时裸说明符报错）
      "mermaid": fileURLToPath(new URL("./src/stub-empty.js", import.meta.url)),
      "@mermaid-js/parser": fileURLToPath(new URL("./src/stub-empty.js", import.meta.url)),
      "cytoscape": fileURLToPath(new URL("./src/stub-empty.js", import.meta.url)),
    },
  },
  server: {
    // 开发时容器外访问：宿主机 8091 → ccweb 容器 8090
    proxy: { "/api": "http://127.0.0.1:8090", "/ws": { target: "ws://127.0.0.1:8090", ws: true } },
  },
});
