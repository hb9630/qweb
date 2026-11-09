// dsweb daemon —— CDP 驱动 DeepSeek 免费网页版，对外提供 OpenAI 兼容端点。
// ccweb qtom 引擎的模型通道：本机跑 daemon + 本机浏览器登录，ccweb --dsweb 连 localhost。
//
// 架构分层：
//   daemon 核心（本文件）：HTTP/OpenAI 面、串行队列、工具桥（文本协议）、
//                         浏览器生命周期、驱动循环（锚点差分/重试/稳态）
//   页面适配（adapters/*.js）：一切触碰 DeepSeek DOM 的代码——改版时只改 adapter，
//                         本 daemon 按文件 mtime 热重载（浏览器/登录态/队列不动）
//
// env：
//   PORT=8300 / DSWEB_TOKEN= / CDP_PORT=9222 / CHROME_BIN= / PROFILE_DIR=~/.dsweb/profile
//   DSWEB_HEADLESS=1（无头长跑，登录需有头一次）/ DSWEB_TIMEOUT_MS=180000 / DISPLAY_NO=99（Linux）
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
let WebSocket;
try { ({ WebSocket } = require('ws')); } catch { console.error('缺依赖：npm install ws'); process.exit(1); }

const PORT = +(process.env.PORT || 8300);
const TOKEN = process.env.DSWEB_TOKEN || '';
const CDP_PORT = +(process.env.CDP_PORT || 9222);
const DISPLAY_NO = process.env.DISPLAY_NO || '99';
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(os.homedir(), '.dsweb/profile');
const HEADLESS = process.env.DSWEB_HEADLESS === '1';
const TIMEOUT_MS = +(process.env.DSWEB_TIMEOUT_MS || 180000);
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const ADAPTERS_DIR = path.join(__dirname, 'adapters');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 页面适配器（mtime 热加载） ----------

let adapter = null, adapterMtime = 0, adapterPath = '';
function loadAdapter() {
  try {
    const st = fs.statSync(adapterPath);
    if (adapter && st.mtimeMs === adapterMtime) return adapter; // 未变
    delete require.cache[require.resolve(adapterPath)];
    adapter = require(adapterPath);
    adapterMtime = st.mtimeMs;
    log(`adapter 热加载: ${adapter.name}@${adapter.version}`);
  } catch (e) {
    if (!adapter) throw new Error(`adapter 加载失败（${adapterPath}）: ${e.message}`);
    log(`adapter 重载失败，沿用旧版: ${e.message}`);
  }
  return adapter;
}
{
  // 首个 adapter 即工作对象（多站点未来可按 urlMatch 路由）
  const files = fs.readdirSync(ADAPTERS_DIR).filter(f => f.endsWith('.js')).sort();
  if (!files.length) { console.error(`adapters/ 目录没有适配器`); process.exit(1); }
  adapterPath = path.join(ADAPTERS_DIR, files[0]);
  loadAdapter();
}

/** UI 尾剥离（从 adapter.uiTail 生成；文本已空白归一，按短语从尾剥） */
function stripUiTail(t) {
  t = t.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const ui of adapter.uiTail || []) {
      if (!ui || ui.length <= 2) continue; // 短词误剥风险高
      const re = new RegExp(ui.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$');
      if (re.test(t)) { t = t.replace(re, '').trim(); changed = true; }
    }
  }
  return t;
}

// ---------- 浏览器生命周期（自愈） ----------

function cdpHttp(p, ms = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: p, timeout: ms }, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('cdp-http-timeout')); });
    req.on('error', reject);
  });
}

let chromeProc = null;

async function ensureXvfb() {
  try { fs.accessSync(`/tmp/.X11-unix/X${DISPLAY_NO}`); return; } catch {}
  log('拉起 Xvfb :' + DISPLAY_NO);
  const xv = spawn('Xvfb', [`:${DISPLAY_NO}`, '-screen', '0', '1920x1080x24'], { detached: true, stdio: 'ignore' });
  xv.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    try { fs.accessSync(`/tmp/.X11-unix/X${DISPLAY_NO}`); return; } catch {}
  }
  throw new Error('Xvfb 起不来（无头 Linux 需装 xvfb；macOS 不需要）');
}

// 浏览器探测：env 显式 > 各平台常规装位 > Linux playwright 缓存 > PATH 兜底
// （Windows 注意：CHROME_BIN 须给 cmd 风格路径 C:\...，git-bash 的 /c/... spawn 不了）
const defaultChrome = (() => {
  const cands = [];
  if (IS_WIN) {
    const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const base of pf) {
      cands.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')); // Chromium 内核兜底
  } else if (IS_MAC) {
    cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
               '/Applications/Chromium.app/Contents/MacOS/Chromium',
               '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  }
  try {
    const base = path.join(os.homedir(), '.cache/ms-playwright');
    const v = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().pop();
    if (v) cands.push(path.join(base, v, IS_MAC ? 'chrome-mac/Chromium.app/Contents/MacOS/Chromium' : 'chrome-linux/chrome'));
  } catch { /* 无 playwright 缓存 */ }
  const fallback = IS_WIN ? 'chrome.exe' : IS_MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'chromium';
  return cands.find((c) => fs.existsSync(c)) || fallback;
})();
const CHROME_BIN = process.env.CHROME_BIN || defaultChrome;

async function ensureChromium() {
  try { await cdpHttp('/json/version'); return; } catch {}
  // 无头不需要 display；有头 Linux 借 Xvfb；macOS/Windows 自带桌面直接开
  if (!HEADLESS && !IS_MAC && !IS_WIN) await ensureXvfb();
  fs.mkdirSync(path.dirname(PROFILE_DIR), { recursive: true });
  log('拉起浏览器 ' + CHROME_BIN + (HEADLESS ? '（无头）' : ''));
  const env = { ...process.env };
  if (!HEADLESS && !IS_MAC && !IS_WIN) env.DISPLAY = `:${DISPLAY_NO}`;
  chromeProc = spawn(CHROME_BIN, [
    ...(IS_MAC || IS_WIN || HEADLESS ? [] : ['--no-sandbox']), // 仅 Linux 有头 root 场景；macOS 弹警告条
    ...(HEADLESS ? ['--headless=new'] : []),
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    ...(IS_MAC || IS_WIN || HEADLESS ? [] : ['--disable-dev-shm-usage']),
    '--window-size=1280,900',
    `--remote-debugging-port=${CDP_PORT}`,
    adapter.homeUrl,
  ], { env, detached: true, stdio: ['ignore', 'ignore', fs.openSync(path.join(path.dirname(PROFILE_DIR), 'chromium.log'), 'a')] });
  chromeProc.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await cdpHttp('/json/version'); log('浏览器就绪'); return; } catch {}
  }
  throw new Error('浏览器起不来（CDP 20s 未就绪；检查 CHROME_BIN 路径）');
}

setInterval(async () => { try { await ensureChromium(); } catch (e) { log('自愈失败:', e.message); } }, 30000);

// ---------- CDP tab ----------

async function connectTab() {
  const list = await cdpHttp('/json/list');
  const t = list.find(x => x.type === 'page' && adapter.urlMatch.test(x.url || ''));
  if (!t) throw new Error(`找不到目标标签页（urlMatch 不命中——检查 adapter 或浏览器打开的站点）`);
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page-js: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200));
    return r.result?.value;
  };
  return { ws, send, evalJs, close: () => ws.close() };
}

// ---------- 驱动循环（引擎无关：锚点差分 + 发送重试 + 稳态） ----------

/** 开新会话：nav 首页并等 adapter.isReady */
async function newSession(tab) {
  await tab.send('Page.enable');
  await tab.send('Page.navigate', { url: adapter.homeUrl });
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    await sleep(500);
    ready = await tab.evalJs(adapter.isReady).catch(() => false);
  }
  if (!ready) throw new Error('对话页未就绪（15s 未出现输入框——若未登录请在浏览器里登录一次）');
}

/**
 * 填充 + 发送 + 等 user 上屏（右列文本出现锚点）+ 稳态检测。返回回复全文。
 * 页面时序不稳：填充读回验证 + 发送不生效重试（共三轮）。onDelta 收"安全外发前缀"
 * 增量（holdback 防 <tool_call 前缀泄漏）。右列几何文本（adapter.readMain）——
 * 排除侧栏/输入残留/虚拟列表镜像；新会话与历史会话两套渲染组件均适用。
 */
async function sendAndWait(tab, text, onDelta) {
  const norm = s => s.replace(/\s+/g, ' ');
  const anchor = norm(text.slice(-60)); // 锚点 = prompt 尾部片段（折行展示，归一匹配）

  let sentOk = false;
  for (let attempt = 0; attempt < 3 && !sentOk; attempt++) {
    // 填充：focus + CDP Input.insertText（输入法级真实输入——native setter 会绕过
    // React ValueTracker，state 不更新则发送键认为"无内容"点击无效，2026-11 实测）
    await tab.evalJs(adapter.fill).catch(() => {});
    await tab.send('Input.insertText', { text });
    const filled = await tab.evalJs(`document.querySelector('textarea') && document.querySelector('textarea').value === ${JSON.stringify(text)}`).catch(() => false);
    if (!filled) { await sleep(1000); continue; } // React 重挂/弹回：稍候重填
    await sleep(400);
    const startPath = await tab.evalJs('location.pathname').catch(() => '');
    // 发送：点发送键（insertText 同步过 React state 后 el.click() 有效）；
    // 点击失败才 Enter 兜底（仅单行文本可靠）
    const clicked = await tab.evalJs(adapter.send).catch(() => false);
    if (!clicked && adapter.enterFallback) {
      await tab.evalJs("document.querySelector('textarea') && document.querySelector('textarea').focus()").catch(() => {});
      await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sleep(80);
      await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    // 发送成功判定（15s 窗）：URL 跳会话页（发消息即建会话，1-2s 可见）
    // 或右列文本出现锚点（消息渲染完，可能数秒）——双信号防误判重复发送
    for (let i = 0; i < 30 && !sentOk; i++) {
      await sleep(500);
      const p = await tab.evalJs('location.pathname').catch(() => '');
      if (p !== startPath) { sentOk = true; break; }
      const main = norm(await tab.evalJs(adapter.readMain).catch(() => ''));
      if (main.includes(anchor)) sentOk = true;
    }
  }
  if (!sentOk) throw new Error('发送失败（3 次尝试 user 消息均未上屏——页面可能弹登录/验证，或 adapter 需更新）');

  // 稳态：右列文本连续 8 次采样不变（4s，跨过会话标题更新的一次离散抖动）
  let sent = 0, lastMain = '', stable = 0;
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error('回复超时 ' + TIMEOUT_MS + 'ms');
    await sleep(500);
    const main = norm(await tab.evalJs(adapter.readMain).catch(() => ''));
    if (main === lastMain) stable++; else stable = 0;
    lastMain = main;
    const idx = main.lastIndexOf(anchor);
    if (idx < 0) continue;
    const cur = stripUiTail(main.slice(idx + anchor.length));
    if (onDelta && cur) {
      const safe = cur.length - holdbackLen(cur); // 尾部疑似 <tool_call 前缀先扣住
      if (safe > sent) { onDelta(cur.slice(sent, safe)); sent = safe; }
    }
    if (stable >= 8 && cur) return cur; // 右列 4s 静默 + 锚点后有内容 = 完成
  }
}

// ---------- 工具桥（模型协议层：OpenAI tools ↔ 文本协议，与页面无关） ----------

function toolsPrompt(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  const lines = tools.map((t, i) => {
    const f = t.function || {};
    const props = Object.entries(f.parameters?.properties || {})
      .map(([k, v]) => `${k}(${v.type || 'any'})`).join(', ');
    const req = (f.parameters?.required || []).join(', ');
    return `${i + 1}. ${f.name} - ${f.description || ''}${props ? ` 参数: {${props}}` : ''}${req ? ` 必填: ${req}` : ''}`;
  }).join('\n');
  return `你可以调用以下工具：\n${lines}\n\n需要调用工具时，只输出一个块，格式严格为：\n<tool_call>{"name": "工具名", "arguments": {…}}</tool_call>\n严格 JSON（无注释/尾逗号），不要包裹代码块，不要加任何其它文字。可以连续输出多个 tool_call 块。\n工具结果会在下一条消息里以 <tool_result name="…">…</tool_result> 形式给出。绝不要编造工具结果；拿到结果前先停住。\n不需要工具时直接回答。\n\n`;
}

/** OpenAI messages（含 tool_calls / role:tool）→ 网页纯文本 */
function flattenMessages(messages) {
  const out = [];
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
    if (m.role === 'user') out.push(`User: ${text}`);
    else if (m.role === 'assistant') {
      let s = text || '';
      for (const c of m.tool_calls || []) {
        let args = c.function?.arguments ?? '{}';
        if (typeof args !== 'string') args = JSON.stringify(args);
        s += `\n<tool_call>${JSON.stringify({ name: c.function?.name, arguments: JSON.parse(args) })}</tool_call>`;
      }
      out.push(`Assistant: ${s.trim()}`);
    } else if (m.role === 'tool') {
      out.push(`User: <tool_result name="tool">${text}</tool_result>`);
    }
  }
  return out.join('\n\n');
}

/** 稳态回复 → {calls, text} | null（无/坏调用 → 降级纯文本） */
function parseToolCalls(reply) {
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m;
  const calls = [];
  while ((m = re.exec(reply))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (!obj || typeof obj.name !== 'string') return null;
      calls.push({
        id: `call_dsweb_${calls.length + 1}`, type: 'function',
        function: { name: obj.name, arguments: JSON.stringify(obj.arguments ?? {}) },
      });
    } catch { return null; }
  }
  if (!calls.length) return null;
  return { calls, text: reply.replace(re, '').trim() };
}

/** 流式 holdback：尾部疑似 <tool_call> 开头的前缀不外发（防协议文本漏进聊天 UI） */
function holdbackLen(t) {
  const TAG = '<tool_call>';
  for (let l = Math.min(t.length, TAG.length); l >= 1; l--) {
    if (t.slice(t.length - l) === TAG.slice(0, l)) return l;
  }
  return 0;
}

/** 一次请求：返回 {text, toolCalls, streamedText}。每请求新会话全量拼接
 *  （tool_calls 结构使会话亲和的前缀匹配失效——恒新会话最稳）。 */
async function chatOnce(body, onDelta) {
  await ensureChromium();
  loadAdapter(); // 热重载检查（改版时替换 adapter 文件即可，无需重启）
  const messages = (body.messages || []).filter(m => m && m.role);
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const sys = messages.filter(m => m.role === 'system').map(m => String(m.content || '')).filter(Boolean).join('\n');
  const conv = messages.filter(m => m.role !== 'system');
  let prompt;
  if (!hasTools && conv.length === 1 && conv[0].role === 'user' && typeof conv[0].content === 'string') {
    prompt = conv[0].content; // 纯聊天单条直发
  } else {
    prompt = (hasTools ? toolsPrompt(body.tools) : '') + (sys ? sys + '\n\n' : '') + flattenMessages(conv);
  }

  const tab = await connectTab();
  try {
    await newSession(tab);
    let streamSent = '';
    const wrapped = d => { streamSent += d; onDelta && onDelta(d); };
    const full = await sendAndWait(tab, prompt, hasTools ? wrapped : onDelta);
    const parsed = hasTools ? parseToolCalls(full) : null;
    if (!parsed) return { text: full, toolCalls: [], streamedText: streamSent };
    return { text: parsed.text, toolCalls: parsed.calls, streamedText: streamSent };
  } finally { tab.close(); }
}

// ---------- 串行队列（单浏览器一路会话流） ----------

let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

// ---------- HTTP 面（OpenAI 兼容） ----------

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > limit) { reject(new Error('body 太大')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/health') {
    let ok = false;
    try { await cdpHttp('/json/version', 2000); ok = true; } catch {}
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok, browser: ok, adapter: adapter.name + '@' + adapter.version, ts: Date.now() }));
  }
  if (req.method === 'POST' && url === '/v1/chat/completions') {
    if (TOKEN && req.headers.authorization !== 'Bearer ' + TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad token' } }));
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad json' } }));
    }
    const messages = (body.messages || []).filter(m => m && (typeof m.content === 'string' || Array.isArray(m.content) || m.tool_calls));
    if (!messages.length || messages[messages.length - 1].role === 'assistant') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'messages 须以 user 结尾' } }));
    }
    const model = body.model || 'deepseek-web';
    const id = 'chatcmpl-dsweb-' + Date.now().toString(36);
    const created = Math.floor(Date.now() / 1000);

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: 'assistant', content: '' }));
      try {
        const r = await enqueue(() => chatOnce(body, d => res.write(chunk({ content: d }))));
        if (r.toolCalls.length) {
          if (!r.streamedText && r.text) res.write(chunk({ content: r.text }));
          res.write(chunk({ tool_calls: r.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: c.function })) }));
          res.write(chunk({}, 'tool_calls'));
        } else {
          if (r.text && r.text.length > r.streamedText.length) res.write(chunk({ content: r.text.slice(r.streamedText.length) }));
          res.write(chunk({}, 'stop'));
        }
        res.write('data: [DONE]\n\n');
      } catch (e) {
        log('请求失败:', e.message);
        res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      return res.end();
    }

    try {
      const r = await enqueue(() => chatOnce(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id, object: 'chat.completion', created, model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: r.text, ...(r.toolCalls.length ? { tool_calls: r.toolCalls } : {}) },
          finish_reason: r.toolCalls.length ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }));
    } catch (e) {
      log('请求失败:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'dsweb_error' } }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' }, hint: 'POST /v1/chat/completions, GET /health' }));
});

server.listen(PORT, '127.0.0.1', () => log(`dsweb daemon 听 127.0.0.1:${PORT}（CDP :${CDP_PORT} · adapter ${adapter.name}@${adapter.version}${IS_WIN ? ' · win 有头' : IS_MAC ? ' · macOS 有头' : HEADLESS ? ' · 无头' : ` · Xvfb :${DISPLAY_NO}`}）`));

