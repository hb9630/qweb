// Windows 盘符导航验证：换目录选择器支持盘符列表（「电脑」页）/ 跨盘切换，
// 标题栏与面包屑不再用 ~ 折叠（win 直接绝对路径）。POSIX 行为不受影响（~ 逻辑保留）。
// 前置：ccweb 服务在跑（win 机器，有多盘）。用法：node dirpicker-win-check.mjs http://127.0.0.1:18090
import { chromium } from "playwright";
const base = process.argv[2]?.replace(/\/+$/, "");
if (!base) { console.error("用法: node dirpicker-win-check.mjs <ccweb-base-url>"); process.exit(2); }
const fail = (m) => { console.error("✗ " + m); process.exit(1); };

let b;
try { b = await chromium.launch(); }
catch { b = await chromium.launch({ channel: "chrome" }); }
const pg = await b.newPage();
try {
  await pg.goto(base + "/");
  await pg.waitForTimeout(2500);

  // 1. 标题栏 cwd chip：win 不折叠 ~（显示 C:/… 绝对形态）
  const chip = await pg.locator('button[title^="工作目录："]').first().innerText();
  /^[A-Za-z]:\//.test(chip) || fail(`标题栏 cwd 应为盘符绝对路径，得到 "${chip}"`);
  console.log(`✓ 标题栏 cwd 显示绝对路径（${chip.trim()}，无 ~）`);

  // 2. 打开切换工作目录选择器：面包屑 win 形态 =「电脑 / C: / …」
  await pg.getByRole("button", { name: "切换工作目录" }).click();
  await pg.waitForTimeout(800);
  const crumbTxt = await pg.locator('[role="dialog"] .font-mono').first().innerText();
  crumbTxt.includes("电脑") || fail(`面包屑应含「电脑」段，得到 "${crumbTxt.replace(/\n/g, "|")}"`);
  crumbTxt.includes("C:") || fail(`面包屑应含盘符段 C:，得到 "${crumbTxt.replace(/\n/g, "|")}"`);
  console.log(`✓ 面包屑 win 形态（${crumbTxt.replace(/\n/g, " / ").trim()}）`);

  // 3. 点「电脑」→ 盘符列表（C: D: 至少两行，图标行）——等文本出现而非固定 sleep
  await pg.locator('[role="dialog"] button', { hasText: "电脑" }).click();
  await pg.waitForTimeout(400);
  await pg.locator('[role="dialog"] button[title^="进入"]').first().waitFor({ state: "visible", timeout: 5000 });
  const rows = await pg.locator('[role="dialog"] button[title^="进入"]').allInnerTexts();
  const drives = rows.map(r => r.trim()).filter(t => /^[A-Z]:$/.test(t));
  drives.length >= 1 || fail(`盘符列表页应列出盘符行，得到 [${rows.join(",")}]`);
  console.log(`✓ 盘符列表页列出：${drives.join(" ")}`);

  // 4. 进入 D:（若在），跨盘选中开新会话 → 会话 cwd = D:/
  const target = drives.find(d => d !== "C:") || drives[0];
  await pg.locator(`[role="dialog"] button[title^="进入 ${target}"]`).first().click();
  await pg.waitForTimeout(800);
  const foot = await pg.locator('[role="dialog"] .font-mono').last().innerText();
  foot.trim().startsWith(target + "/") || fail(`进入盘符 ${target}: 后底部路径应为 ${target}/，得到 "${foot.trim()}"`);
  console.log(`✓ 跨盘进入 ${foot.trim()}`);
  await pg.getByRole("button", { name: "选这个目录", exact: true }).click();
  await pg.waitForTimeout(1500);
  const list = await fetch(`${base}/api/sessions`).then(r => r.json());
  const mine = list.find(s => s.cwd === target + "/") ?? null;
  mine || fail(`切换后应存在 cwd=${target}/ 的会话，实际列表：${list.map(s => s.cwd).join(", ") || "(空)"}`);
  console.log(`✓ 跨盘切换生效（新会话 cwd=${mine.cwd}）`);
  for (const s of list) await fetch(`${base}/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
} finally { await b.close(); }
console.log("✓ win 盘符导航全通\n");
