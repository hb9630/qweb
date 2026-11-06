// 右键菜单回归测试（jsdom 事件级）。运行：
//   npx esbuild src/Explorer.tsx --bundle --format=esm --platform=browser --jsx=automatic --outfile=.test-explorer.mjs --alias:@=./src --external:react --external:react-dom --external:react/jsx-runtime && node test-menu.mjs
// 注意：jsdom 不模拟"mousedown 聚焦/blur"，焦点类 bug 只能真浏览器复现（见 Explorer.tsx MI 注释）
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: "http://localhost/", pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.localStorage = dom.window.localStorage;

// mock fetch：/api/fs 有状态（rename 改列表）；POST 记录下来（验证 blur=确认）
const posts = [];
const files = [{ name: "a.txt", size: 12 }];
globalThis.fetch = async (url, opts) => {
  if (opts?.method === "POST") {
    posts.push({ url: String(url), body: opts.body });
    try {
      const q = JSON.parse(opts.body);
      if (q.op === "rename" && files[0]) files[0].name = String(q.to).split("/").pop();
    } catch {}
  }
  return {
    ok: true,
    json: async () => (String(url).startsWith("/api/fs/dirs")
      ? { path: decodeURIComponent(String(url).split("path=")[1] || ""), dirs: ["sub"], drives: false }
      : String(url).startsWith("/api/fs?")
        ? { dirs: ["sub"], files }
        : []),
  };
};

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Explorer } = await import("./.test-explorer.mjs");

const opened = [];
const setRootCalls = [];
const tick = () => new Promise((r) => setTimeout(r, 0));
const fire = (el, type, opts = {}) => {
  const e = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, view: dom.window, ...opts });
  el.dispatchEvent(e);
  return e;
};

const root = createRoot(document.getElementById("root"));
root.render(React.createElement(Explorer, {
  root: "/root",
  home: "/root",
  setRoot: (p) => setRootCalls.push(p),
  onOpenFile: (p, pinned) => opened.push([p, pinned]),
  activeFile: null,
}));
await tick(); await tick();

await new Promise((r) => setTimeout(r, 50));
const row = document.querySelector('[data-path="/root/a.txt"]');
if (!row) {
  console.error("FAIL: 文件行未渲染，body 摘要:", document.body.innerHTML.slice(0, 600));
  process.exit(1);
}
console.log("✓ 文件行已渲染:", row.dataset.path);

// --- 场景1：右键文件 → 菜单应出现 ---
fire(row, "mousedown", { button: 2 });
fire(row, "mouseup", { button: 2 });
fire(row, "contextmenu");
await tick();
let menu = document.querySelector(".fixed.z-50");
console.log(menu ? "✓ 右键后菜单已出现" : "✗ 右键后菜单未出现");
if (!menu) process.exit(1);

// --- 场景2：菜单开着时，文件行再右键 → 应切换为新菜单（回归：第一次不灵）---
fire(row, "contextmenu");
await tick();
menu = document.querySelector(".fixed.z-50");
console.log(menu ? "✓ 菜单开着再右键仍正常" : "✗ 菜单开着再右键被关掉（回归）");

// --- 场景3：点"打开"：mousedown 时菜单不能被 window 监听误关 ---
const findMI = (label) => [...document.querySelectorAll(".fixed.z-50 button")]
  .find((b) => b.textContent.trim().startsWith(label));
let openBtn = findMI("打开");
if (!openBtn) { console.error("✗ 菜单里没有『打开』项，现有项:", [...document.querySelectorAll(".fixed.z-50 button")].map((b) => b.textContent)); process.exit(1); }
fire(openBtn, "mousedown", { button: 0 });
await tick();
menu = document.querySelector(".fixed.z-50");
console.log(menu ? "✓ mousedown 后菜单存活（stopPropagation 生效）" : "✗ mousedown 把菜单关了 → click 永远不触发【这就是打不开的根因】");
fire(openBtn, "mouseup", { button: 0 });
fire(openBtn, "click");
await tick();
console.log(opened.length ? `✓ onOpenFile 已触发: ${JSON.stringify(opened)}` : "✗ onOpenFile 从未触发（打不开）");

// --- 场景4：菜单项点击后菜单应关闭 ---
console.log(document.querySelector(".fixed.z-50") ? "✗ 点击后菜单未关闭" : "✓ 点击后菜单关闭");

// --- 场景5：双击文件 = 钉住 ---
fire(row, "click");
fire(row, "click");
fire(row, "dblclick");
await tick();
console.log(opened.some(([p, pin]) => p === "/root/a.txt" && pin === true) ? "✓ 双击触发 pinned=true" : "✗ 双击未触发 pinned=true");

// --- 场景6：点路径栏 → 目录选择器 → 下钻 → 选择此目录 → setRoot ---
{
  await new Promise((r) => setTimeout(r, 50));
  const pathBar = [...document.querySelectorAll("aside [title]")].find((b) => b.title?.includes("选择工作目录"));
  if (!pathBar) console.log("✗ 路径栏按钮未找到");
  else {
    fire(pathBar, "click");
    await new Promise((r) => setTimeout(r, 60));
    const subBtn = [...document.querySelectorAll("aside button")].find((b) => b.textContent === "sub");
    const okBtn = [...document.querySelectorAll("aside button")].find((b) => b.title === "选择此目录");
    console.log(subBtn && okBtn ? "✓ 目录选择器出现（含子目录与确认钮）" : `✗ 选择器异常: sub=${!!subBtn} ok=${!!okBtn}`);
    if (subBtn) {
      fire(subBtn, "click"); // 下钻 /root/sub
      await new Promise((r) => setTimeout(r, 60));
      const ok2 = [...document.querySelectorAll("aside button")].find((b) => b.title === "选择此目录");
      fire(ok2, "click");
      await tick();
      console.log(setRootCalls.length && setRootCalls[setRootCalls.length - 1] === "/root/sub"
        ? `✓ setRoot 收到 /root/sub（App 层 setWorkspace 联动换会话+记忆）` : `✗ setRoot 异常: ${JSON.stringify(setRootCalls)}`);
    }
  }
}

// --- 场景7：新建文件输入行，点击外部（blur）= 确认提交 ---
{
  await new Promise((r) => setTimeout(r, 50));
  const dirRow = document.querySelector('[data-path="/root/sub"]');
  fire(dirRow, "click"); // 先展开目录（EditRow 渲染在展开区之下）
  await new Promise((r) => setTimeout(r, 50));
  fire(dirRow, "contextmenu");
  await tick();
  const newBtn = findMI("新建文件");
  fire(newBtn, "click");
  await tick();
  const input = document.querySelector("aside input.border-ring");
  if (!input) console.log("✗ 新建输入行未出现");
  else {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "note.md");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await tick();
    input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true })); // React onBlur 委托 focusout
    await tick();
    const p = posts.find((x) => x.body && x.body.includes("note.md"));
    console.log(p ? `✓ blur=确认提交（POST ${p.url} name=note.md）` : `✗ blur 未提交: ${JSON.stringify(posts)}`);
  }
}

// --- 场景8：重命名默认只选中主文件名（a.txt → 选 [0,1)，后缀不选中）---
{
  await new Promise((r) => setTimeout(r, 50));
  const frow = document.querySelector('[data-path="/root/a.txt"]');
  fire(frow, "contextmenu");
  await tick();
  fire(findMI("重命名"), "click");
  await tick();
  const input = document.querySelector("aside input.border-ring");
  if (!input) console.log("✗ 重命名输入行未出现");
  else {
    const { selectionStart: s, selectionEnd: e } = input;
    console.log(s === 0 && e === 1 ? `✓ 重命名只选主文件名（a.txt 选 [0,1)）` : `✗ 选区异常: [${s},${e})`);
    // 提交重命名 a.txt → b.txt，新名字行应保持选中
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "b.txt");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await tick();
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 80));
    const nrow = document.querySelector('[data-path="/root/b.txt"]');
    const picked = nrow && (nrow.className.includes("bg-accent") || nrow.className.includes("bg-[oklch(0.58"));
    console.log(picked
      ? `✓ 重命名后新名字保持选中（${nrow.className.includes("bg-[") ? "当前项深底" : "bg-accent"}）`
      : `✗ 新行选中态异常: ${nrow ? nrow.className : "行未渲染"}`);
  }
}

// --- 场景9：展开状态持久化：展开过 sub → 重挂载后 sub 自动展开 ---
{
  await new Promise((r) => setTimeout(r, 50));
  const saved = localStorage.getItem("ccweb.expanded");
  const dirRow2 = document.querySelector('[data-path="/root/sub"]');
  console.log(saved && saved.includes("/root/sub") && dirRow2
    ? `✓ 展开已持久化（localStorage: ${saved}）`
    : `✗ 持久化异常: ls=${saved} sub行=${!!dirRow2}`);
  // 重挂载（模拟刷新：先卸载再挂载，触发初始加载 effect）→ sub 应恢复展开
  root.render(null); await tick();
  root.render(React.createElement(Explorer, {
    root: "/root", home: "/root",
    setRoot: (p) => setRootCalls.push(p),
    onOpenFile: (p, pinned) => opened.push([p, pinned]),
    activeFile: null,
  }));
  // jsdom+大bundle下初始加载链路 ~500ms（restoreOpen 递归再拉子目录），轮询等够
  // 注：mock 有状态，场景8 已把 a.txt 改名 b.txt——子文件行断言用 b.txt
  let subChild = null;
  for (let i = 0; i < 40 && !subChild; i++) {
    subChild = document.querySelector('[data-path="/root/sub/b.txt"]');
    if (!subChild) await new Promise((r) => setTimeout(r, 100));
  }
  console.log(subChild
    ? "✓ 重挂载后展开恢复（/root/sub 子行可见，含场景8改名后的 b.txt）"
    : `✗ 恢复异常：现有路径=${JSON.stringify([...document.querySelectorAll("[data-path]")].map((e) => e.dataset.path))} ls=${localStorage.getItem("ccweb.expanded")}`);
}

// --- 场景10：选中持久化：点击文件后 localStorage 记录，重挂载后选中恢复 ---
{
  // 先点一个文件产生选中（b.txt 在顶层，mock 有状态：a.txt 已被场景8改名 b.txt）
  let frow = null;
  for (let i = 0; i < 20 && !frow; i++) {
    frow = document.querySelector('[data-path="/root/b.txt"]');
    if (!frow) await new Promise((r) => setTimeout(r, 100));
  }
  if (!frow) console.log("✗ b.txt 行未出现");
  else {
    fire(frow, "mousedown", { button: 0, bubbles: true });
    await tick();
    const sv = localStorage.getItem("ccweb.sel");
    console.log(sv && sv.includes("/root/b.txt")
      ? `✓ 选中已持久化（${sv}）` : `✗ 持久化异常: ${sv}`);
    // 重挂载恢复
    root.render(null); await tick();
    root.render(React.createElement(Explorer, {
      root: "/root", home: "/root",
      setRoot: (p) => setRootCalls.push(p),
      onOpenFile: (p, pinned) => opened.push([p, pinned]),
      activeFile: null,
    }));
    let picked = null;
    for (let i = 0; i < 40 && !picked; i++) {
      const row2 = document.querySelector('[data-path="/root/b.txt"]');
      // 必须是"真选中"深底白字（treeFocus 聚焦后 isCur 分支），失焦淡底 bg-accent 不算恢复到位
      if (row2 && row2.className.includes("bg-[oklch(0.58")) picked = row2;
      else await new Promise((r) => setTimeout(r, 100));
    }
    console.log(picked ? "✓ 重挂载后选中恢复为真选中色（b.txt 深底白字当前项）" : "✗ 恢复后仍是失焦淡底/无选中");
  }
}

root.unmount();
