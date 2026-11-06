// Editor 预览标签 + 热打开时间逻辑测试（jsdom，Date.now 可控）
// 运行：npx esbuild src/Editor.tsx --bundle --format=esm --platform=browser --jsx=automatic --outfile=.test-editor.mjs --alias:@=./src --alias:@mermaid-js/parser=./test-stubs/mermaid-parser.mjs --alias:cytoscape=./test-stubs/cytoscape.mjs --loader:.css=empty --loader:.ttf=dataurl --loader:.woff2=dataurl --loader:.woff=dataurl --external:react --external:react-dom --external:react/jsx-runtime && node test-editor.mjs
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost/", pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.localStorage = dom.window.localStorage;

// jsdom 未实现 scrollIntoView：stub 并记录调用（回归"激活 tab 滚进视窗"）
const scrolled = [];
dom.window.HTMLElement.prototype.scrollIntoView = function (...a) { scrolled.push(this.textContent, a[0]); };

globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: "x", size: 1, binary: false }) });

// 可控时钟
const realNow = Date.now.bind(Date);
let fake = 1_000_000;
Date.now = () => fake;
const tick = () => new Promise((r) => setTimeout(r, 30));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Editor } = await import("./.test-editor.mjs");

const root = createRoot(document.getElementById("root"));
let seq = 0;
const open = (path, pinned = false) => {
  root.render(React.createElement(Editor, { openReq: { path, pinned, seq: ++seq } }));
};
const tabs = () => [...(document.querySelector(".h-9")?.querySelectorAll(".truncate") ?? [])]
  .filter((e) => /^f\d\.txt$/.test(e.textContent));
const names = () => tabs().map((e) => e.textContent);
const italic = (name) => tabs().find((e) => e.textContent === name)?.className.includes("italic");

root.render(React.createElement(Editor, { openReq: null }));
await tick();

// 1) 首次打开（冷）：新 tab，斜体预览
open("f1.txt"); await tick(); await tick();
console.log(names().length === 1 && italic("f1.txt") ? "✓ 首次打开=新预览tab" : `✗ 首次打开异常: ${names()}`);

// 2) 400ms 后再开（热）：原地替换，仍 1 个 tab
fake += 400; open("f2.txt"); await tick(); await tick();
console.log(names().length === 1 && names()[0] === "f2.txt" ? "✓ 热打开=替换预览（1个tab）" : `✗ 热打开异常: ${names()}`);

// 3) 再 400ms 连续热浏览第三个文件
fake += 400; open("f3.txt"); await tick(); await tick();
console.log(names().length === 1 && names()[0] === "f3.txt" ? "✓ 连续热浏览仍 1 个 tab" : `✗ 连续热浏览异常: ${names()}`);

// 4) 停留 2s 后再开（冷）：f3 自动转正（无斜体），f4 新预览 tab，共 2 个
fake += 2000; open("f4.txt"); await tick(); await tick();
console.log(names().length === 2 && !italic("f3.txt") && italic("f4.txt")
  ? "✓ 冷打开=旧预览自动转正+新预览tab（2个tab）" : `✗ 冷打开异常: ${names()} f3斜体=${italic("f3.txt")} f4斜体=${italic("f4.txt")}`);

// 5) 热打开只替换预览，不碰已转正的 f3
fake += 300; open("f5.txt"); await tick(); await tick();
console.log(names().length === 2 && names().includes("f3.txt") && names().includes("f5.txt")
  ? "✓ 热打开只替换预览，转正tab保留" : `✗ 替换异常: ${names()}`);

// 6) 双击钉住（pinned 请求）新文件：追加正式 tab（非热替换）
fake += 100; open("f6.txt", true); await tick(); await tick();
console.log(names().length === 3 && !italic("f6.txt") ? "✓ pinned=追加新正式tab" : `✗ pinned异常: ${names()}`);

// 7) 打开已开的文件：仅激活不新增
fake += 3000; open("f3.txt"); await tick(); await tick();
console.log(names().length === 3 ? "✓ 已开文件=仅激活" : `✗ 已开文件异常: ${names()}`);

// 8) 激活 tab 应滚动进视窗：每次激活变化都对激活 tab 调 scrollIntoView({inline:"nearest"})
{
  const calls = scrolled.filter((_, i) => i % 2 === 0);
  const last = calls[calls.length - 1];
  console.log(last === "f3.txt" && scrolled.some((s) => s?.inline === "nearest")
    ? `✓ 激活tab滚动进视窗（当前=${last}，共${calls.length}次）`
    : `✗ 激活tab未滚动: 最后=${last} calls=${JSON.stringify(calls)}`);
}

// 9) tab 右键菜单：关闭 / 全部关闭
{
  const menu = () => [...document.querySelectorAll("button")].filter((b) => /^(关闭|全部关闭)$/.test(b.textContent));
  const rc = (name) => tabs().find((e) => e.textContent === name)
    ?.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  rc("f5.txt"); await tick();
  let items = menu();
  console.log(items.length === 2 ? "✓ tab右键菜单出现（关闭/全部关闭）" : `✗ 菜单异常: ${items.map((b) => b.textContent)}`);
  items.find((b) => b.textContent === "关闭")?.click(); await tick();
  console.log(!names().includes("f5.txt") && names().length === 2 && !menu().length
    ? `✓ 关闭指定tab: ${names()}` : `✗ 关闭异常: ${names()} 菜单残留=${menu().length}`);
  rc("f3.txt"); await tick();
  menu().find((b) => b.textContent === "全部关闭")?.click(); await tick();
  console.log(names().length === 0 ? "✓ 全部关闭" : `✗ 全部关闭异常: ${names()}`);
}

Date.now = realNow;
root.unmount();
