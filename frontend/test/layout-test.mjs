// chat-first 布局回归（自管 vite preview + API mock，无后端依赖）。运行：
//   node test/layout-test.mjs   （需先 npm run build 出 dist）
// 覆盖：纯对话初始态 / cwd chip 开关树浮层 / 点文件编辑器贴树右 / 内容列避让 /
//       编辑器 X 独立收（树保留）/ ▾ 历史工作目录 / 换目录选择器面包屑 / 末 tab 收编辑器留树
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const PORT = 4180;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, label) => { console.log(cond ? `✓ ${label}` : `✗ ${label}`); if (!cond) fails++; };

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
// 等就绪（npx 启动有开销，轮询替代固定 sleep）
{
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(500);
    try { await fetch(`${BASE}/`); ready = true; } catch {}
  }
  if (!ready) { console.log("✗ vite preview 未就绪"); server.kill(); process.exit(1); }
}

try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // API mock：静态文件系统（sub 目录 + 两个文件）
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const j = (b) => route.fulfill({ body: JSON.stringify(b), contentType: "application/json" });
    if (url.includes("/api/env")) return j({ home: "/home/u", models: ["sonnet"] });
    if (url.includes("/api/history")) return j([]);
    if (/\/api\/sessions(\?|$)/.test(url) && route.request().method() === "GET") return j([]);
    if (url.includes("fs?path")) return j({ dirs: ["sub"], files: [{ name: "hello.py", size: 12 }] });
    if (url.includes("/api/fs/raw") || url.includes("/api/fs/file")) return j({ content: "x=1\n", binary: false, size: 4 });
    return j({});
  });
  await page.goto(BASE);
  await page.waitForLoadState("networkidle");
  await sleep(1000);

  // 1) 初始 = 纯对话全宽（浮层默认全关）
  ok(!(await page.locator("aside").isVisible()), "初始无目录树（纯对话全宽）");
  const chip = page.locator("button[title^='工作目录']");
  ok(await chip.isVisible(), "标题栏 cwd chip 可见");

  // 2) 点 chip → 树浮层从标题栏下方展开（left:0 垂到底）
  await chip.click();
  await sleep(700);
  const treeR = await page.evaluate(() => document.querySelector("aside")?.closest("div[class*='absolute']")?.getBoundingClientRect().toJSON());
  ok(treeR && treeR.left === 0 && treeR.top > 30 && treeR.bottom >= 890, `树浮层贴左边垂到底 (${treeR?.left},${treeR?.top}→${treeR?.bottom})`);

  // 3) 点文件 → 编辑器浮层紧贴树右
  await page.locator("button[data-path='/home/u/hello.py']").click();
  await sleep(800);
  const edR = await page.evaluate(() => {
    const els = [...document.querySelectorAll("div[class*='absolute bottom-0']")];
    const ed = els.find((d) => !d.querySelector("aside") && d.className.includes("border-l"));
    return ed?.getBoundingClientRect().toJSON();
  });
  ok(edR && Math.abs(edR.left - treeR.right) < 2, `编辑器贴树右（tree.right=${treeR.right}, ed.left=${edR?.left}）`);

  // 3.5) 分割线拖动：树|编辑器缝可拖（调树宽）；编辑器右缘拖右加宽；均还原
  {
    const drag = async (x, dx) => {
      await page.mouse.move(x, 500);
      await page.mouse.down();
      await page.mouse.move(x + dx, 500, { steps: 5 });
      await page.mouse.up();
      await sleep(400);
    };
    const treeRight = () => page.evaluate(() =>
      Math.round(document.querySelector("aside").closest("div[class*='absolute']").getBoundingClientRect().right));
    const edWidth = () => page.evaluate(() => {
      const el = [...document.querySelectorAll("div[class*='absolute bottom-0']")]
        .find((d) => !d.querySelector("aside") && d.className.includes("border-l"));
      return Math.round(el.getBoundingClientRect().width);
    });
    const t0 = await treeRight();
    await drag(t0, 60);
    const t1 = await treeRight();
    ok(Math.abs(t1 - t0 - 60) < 3, `缝拖动调树宽（${t0}→${t1}）`);
    await drag(t1, -60);
    const w0 = await edWidth();
    const edRightX = () => page.evaluate(() => Math.round(
      [...document.querySelectorAll("div[class*='absolute bottom-0']")]
        .find((d) => !d.querySelector("aside") && d.className.includes("border-l"))
        .getBoundingClientRect().right));
    await drag(await edRightX(), 80);
    const w1 = await edWidth();
    ok(Math.abs(w1 - w0 - 80) < 3, `编辑器右缘拖右加宽（${w0}→${w1}）`);
    await drag(await edRightX(), -80); // 还原
  }

  // 4) 内容列避让：输入框整体在编辑器右侧（含拖宽把手 ~8px 占位，不被压边）
  const ta = await page.evaluate(() => document.querySelector("textarea[name='message']")?.getBoundingClientRect().toJSON());
  ok(ta && ta.left >= edR.right + 5, `输入框避让浮层+把手（ta.left=${ta?.left} >= ed.right+5=${edR.right + 5}）`);

  // 5) 编辑器头部"关闭面板"X → 只收编辑器（树保留，各自独立关闭）
  await page.locator("button[title='关闭面板']").last().click();
  await sleep(500);
  const afterEdX = await page.evaluate(() =>
    [...document.querySelectorAll("div[class*='absolute bottom-0']")].map((d) => !!d.querySelector("aside")));
  ok(afterEdX.length === 2 && afterEdX[0] === true, `编辑器 X 独立收（树保留，floats=${JSON.stringify(afterEdX)}）`);

  // 6) ▾ 历史工作目录（预置 recents；当前目录打勾）
  await page.addInitScript(() => localStorage.setItem("ccweb.recents", JSON.stringify(["/home/u"])));
  await page.goto(BASE); // 重新走 init 注入（addInitScript 只对下次导航生效）
  await page.waitForLoadState("networkidle");
  await sleep(900);
  await page.locator("button[title^='历史工作目录']").click();
  await sleep(400);
  const panel = page.locator("div[role='dialog']");
  ok(await panel.isVisible(), "▾ 弹出历史工作目录面板");
  ok(await panel.getByRole("button", { name: /~/ }).count() >= 1, "历史列表有条目");
  await page.mouse.click(700, 500); // 点空白关闭
  await sleep(300);

  // 7) 换目录选择器：面包屑 + ✓ 确认钮 + 进入子目录
  await page.locator("button[title^='换工作目录']").click();
  await sleep(500);
  ok(await page.getByText("选这个目录").isVisible(), "选择器底部 ✓ 确认栏");
  await page.locator("div[role='dialog'] button[title^='进入']").click();
  await sleep(500);
  const crumb = await page.locator("div[role='dialog'] button", { hasText: "sub" }).last().textContent();
  ok(!!crumb, `面包屑下钻到 sub（${crumb}）`);
  await page.mouse.click(900, 500); // 点空白关掉选择器
  await sleep(300);

  // 8) 末 tab 关闭 → 编辑器收、树保留
  // （第 5 步树保留 → ccweb.layout 持久化 showTree:true → goto 后树已自动开，chip 只在关着时才点）
  if (!(await page.locator("aside").isVisible())) {
    await page.locator("button[title^='工作目录']").click();
    await sleep(600);
  }
  await sleep(500);
  await page.locator("button[data-path='/home/u/hello.py']").click();
  await sleep(800);
  await page.locator("div.group:has(span:text-is('hello.py')) span.ml-auto svg").first().click();
  await sleep(700);
  const floats = await page.evaluate(() =>
    [...document.querySelectorAll("div[class*='absolute bottom-0']")].map((d) => !!d.querySelector("aside")));
  ok(floats.length === 2 && floats[0] === true, `末 tab 关闭后只剩树（floats=${JSON.stringify(floats)}）`);

  await browser.close();
} catch (e) {
  console.log("PAGE-ERR:", e.message.split("\n")[0]);
  fails++;
} finally {
  server.kill();
}
console.log(fails ? `✗ ${fails} 项失败` : "✓ 布局回归全部通过");
process.exit(fails ? 1 : 0);
