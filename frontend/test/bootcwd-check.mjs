// 初始 cwd 显示验证：打开页面即显示 home 路径，无"（未设定）"窗口。
// 场景 A：清空全部本地状态（首访）——env 拦截延迟 2s，期间应显示"…"而非"（未设定）"
// 场景 B：保留 qweb.home 缓存（二次访问）——env 同样延迟，期间应直接显示 home 绝对路径
import { chromium } from "playwright";
const base = "http://127.0.0.1:18090/";
let b; try { b = await chromium.launch(); } catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
await pg.route("**/api/env", async r => { await new Promise(res => setTimeout(res, 2000)); await r.continue(); });

// A：首访（无任何缓存）——init script 每次导航都跑，用 sessionStorage 标记只清一次（B 要留缓存）
await pg.addInitScript(() => {
  if (!sessionStorage.getItem("__bootClear")) { localStorage.clear(); sessionStorage.setItem("__bootClear", "1"); }
});
await pg.goto(base);
await pg.waitForTimeout(600); // env 仍在拦延迟中
let chip = await pg.locator('button[title^="工作目录："]').first().innerText();
chip.includes("未设定") && (() => { throw new Error("✗ 首访 env 未回时显示了「（未设定）」：" + chip); })();
console.log(`✓ 首访 env 未回时无「（未设定）」（显示 "${chip.trim()}"）`);
await pg.waitForTimeout(3900); // env 到达（bundle 加载后 fetch + 2s 拦截延迟，留足余量）
chip = await pg.locator('button[title^="工作目录："]').first().innerText();
/^(C:\/Users|~)/.test(chip) || (() => { throw new Error("✗ env 到达后应显示 home 路径：" + chip); })();
console.log(`✓ env 到达后显示 home（${chip.trim()}）`);

// B：二次访问（qweb.home 已缓存）
await pg.goto("about:blank");
await pg.goto(base);
await pg.waitForTimeout(500);
chip = await pg.locator('button[title^="工作目录："]').first().innerText();
chip.includes("C:/Users") || (() => { throw new Error("✗ 二次访问应零等待显示 home 缓存：" + chip); })();
console.log(`✓ 二次访问零等待显示 home 缓存（${chip.trim()}）`);
await b.close();
console.log("✓ 初始 cwd 显示全通\n");
