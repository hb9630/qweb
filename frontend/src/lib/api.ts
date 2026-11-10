// 零配置 base_path:入口 URL 必带尾斜杠(server 对无锚点路径 301 补上),
// 文档目录即 base——从地址栏自推导,不依赖任何注入。本地直跑(根路径)= 空串。
// API/WS 一律经此前缀拼接
const dir = new URL(".", location.href).pathname; // "/app/{cid}-{port}/" 或 "/"
export const BASE: string = dir.length > 1 ? dir.slice(0, -1) : "";
export const API = `${BASE}/api`;

// 会话锚点：#s=<官方会话ID>。hash 不进服务端路由、不影响 BASE 的 pathname 推导；
// 刷新时 boot 优先认锚点精确恢复该会话（多 tab/重启后不再赌"最近"）。
// replaceState 写入不产生历史条目（后退仍是页面级导航）
export const hashSid = (): string | null => /^#s=([0-9a-f-]{8,})/.exec(location.hash)?.[1] ?? null;
export const setHashSid = (sid: string | null) => {
  if (sid === hashSid()) return;
  history.replaceState(null, "", sid ? `#s=${sid}` : location.pathname + location.search);
};

// /api/history 的 in-flight 复用：启动链路上多处要它（mount 期 refresh 拉分组、
// root 智能默认挑"最近有会话的目录"）——后端要全量扫 projects 目录，是启动最慢一环，
// 各拉一遍 = 树区转圈时间翻倍。同一窗口期共享一个在途 promise，5s 后过期真拉新。
let histInflight: Promise<any> | null = null;
export function fetchHistoryOnce(): Promise<any> {
  if (!histInflight) {
    histInflight = fetch(`${API}/history`).then((r) => r.json());
    setTimeout(() => { histInflight = null; }, 5000);
  }
  return histInflight;
}
