// 图片查看器交互测试：拖拽平移（小手）+ 滚轮缩放锚点
// 运行（frontend/test/ 内）：npx esbuild ../src/Editor.tsx --bundle --format=esm --platform=browser --jsx=automatic --outfile=.test-editor.mjs --alias:@=../src --alias:@mermaid-js/parser=./stubs/mermaid-parser.mjs --alias:cytoscape=./stubs/cytoscape.mjs --loader:.css=empty --loader:.ttf=dataurl --loader:.woff2=dataurl --loader:.woff=dataurl --external:react --external:react-dom --external:react/jsx-runtime && node test-image.mjs
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost/", pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true }); // Node ≥21 navigator 只读
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.localStorage = dom.window.localStorage;
globalThis.Blob = dom.window.Blob;
globalThis.URL = dom.window.URL;
globalThis.URL.createObjectURL = () => "blob:fake-" + Math.random();
globalThis.URL.revokeObjectURL = () => {};

globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => (String(url).startsWith("/api/fs/file")
    ? { content: null, size: 900, binary: true }
    : { dirs: [], files: [] }),
  blob: async () => new globalThis.Blob(["xx"], { type: "image/png" }),
});

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Editor } = await import("./.test-editor.mjs");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const fire = (el, type, opts) =>
  el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window, ...opts }));

const root = createRoot(document.getElementById("root"));
let seq = 0;
root.render(React.createElement(Editor, { openReq: null }));
await tick(30);
root.render(React.createElement(Editor, { openReq: { path: "/root/a.png", pinned: false, seq: ++seq } }));
await tick(300);

const img = document.querySelector("img");
const box = img?.closest("div");
if (!img || !box) { console.error("FAIL: 图片/容器未渲染; body:", document.body.innerHTML.slice(2000, 2700)); process.exit(1); }

box.addEventListener("mousedown", () => console.log("[probe] 原生 mousedown 到达容器"));
window.addEventListener("mousemove", () => console.log("[probe] 原生 mousemove 到达 window"));
img.__tagged = true;
box.addEventListener("wheel", () => console.log("[probe] 原生 wheel 到达容器"), { passive: true });
const tf = () => img.style.transform || "(none)";
console.log("✓ 图片已渲染, 初始 transform:", tf());

// --- 拖拽平移（100% 缩放下也应生效）---
fire(box, "mousedown", { button: 0, clientX: 100, clientY: 100 });
await tick(5);
console.log("[probe] mousedown后容器class:", box.className);
fire(window, "mousemove", { clientX: 140, clientY: 120, buttons: 1 });
await tick(5);
fire(window, "mouseup", { clientX: 140, clientY: 120, buttons: 0 });
await tick(30);
const img2 = document.querySelector("img");
console.log("[probe] img 节点同一:", img2 === img, "| transform:", img2.style.transform);
const afterDrag = tf();
console.log(afterDrag.includes("translate(40px, 20px)")
  ? `✓ 100% 下拖拽生效: ${afterDrag}`
  : `✗ 拖拽未生效（小手失效复现）: ${afterDrag}`);

// --- 松开后移动不得再跟（监听泄漏回归）---
fire(window, "mousemove", { clientX: 180, clientY: 150, buttons: 0 });
await tick(30);
const afterLeak = tf();
console.log(afterLeak === afterDrag || !afterLeak.includes("translate(80")
  ? `✓ 松开后移动不跟手: ${afterLeak}`
  : `✗ 松开后仍在跟手（泄漏复现）: ${afterLeak}`);

// --- 漏 mouseup 的自愈：按住拖动后无 mouseup、buttons=0 的下一次移动即停 ---
fire(box, "mousedown", { button: 0, clientX: 200, clientY: 200 });
await tick(5);
fire(window, "mousemove", { clientX: 230, clientY: 210, buttons: 1 });
await tick(30);
const midDrag = tf();
fire(window, "mousemove", { clientX: 300, clientY: 260, buttons: 0 }); // 已松开（无 mouseup）
await tick(5);
fire(window, "mousemove", { clientX: 400, clientY: 300, buttons: 0 }); // 应已自愈停住
await tick(30);
const healed = tf();
console.log(healed === midDrag
  ? `✓ 漏 mouseup 自愈: 停在 ${healed}`
  : `✗ 自愈失败: ${midDrag} -> ${healed}`);

// --- 滚轮缩放：scale 变化 + pan 锚点补偿 ---
const before = tf();
img.closest("div").dispatchEvent(new dom.window.WheelEvent("wheel", {
  bubbles: true, cancelable: true, deltaY: -100, clientX: 50, clientY: 50,
}));
await tick(30);
const after = tf();
console.log(after !== before && after.includes("scale(1.25)")
  ? `✓ 滚轮缩放生效: ${after}`
  : `✗ 滚轮缩放未生效: ${after}`);
console.log(/translate\(-?[\d.]+px, -?[\d.]+px\)/.test(after) && after !== before
  ? "✓ 缩放时 pan 有锚点补偿（位置偏移逻辑在跑）"
  : "（注意）缩放后 pan 无变化");

root.unmount();
