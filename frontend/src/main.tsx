// 启动打一次构建号(排查对齐用):F12 console 可见
console.info("[ccweb] build", typeof __BUILD_TAG__ !== "undefined" ? __BUILD_TAG__ : "dev");
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Toaster } from "@/components/ui/sonner";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Toaster richColors position="top-center" />
  </React.StrictMode>
);
