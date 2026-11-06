// 文件变更订阅：全局单连接 /ws/fs。watchDir 引用计数（树展开目录 + 打开文件所在目录），
// useFsEvent 注册回调；服务端 inotify 事件驱动（无轮询），断线指数退避重连后自动重发订阅。
import { useEffect } from "react";
import { BASE } from "./api";

type Cb = (dirs: string[]) => void;
const cbs = new Set<Cb>();
const want = new Map<string, number>();
let ws: WebSocket | null = null;
let opening = false;
let retryMs = 500;

function sync() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: "sub", dirs: [...want.keys()] }));
  }
}
function connect() {
  if (opening || (ws && ws.readyState <= WebSocket.OPEN)) return;
  opening = true;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const w = new WebSocket(`${proto}://${location.host}${BASE}/ws/fs`);
  ws = w;
  w.onopen = () => { opening = false; retryMs = 500; sync(); };
  w.onmessage = (e) => {
    let m: { t?: string; dirs?: string[] };
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.t === "fs" && Array.isArray(m.dirs)) for (const cb of cbs) cb(m.dirs);
  };
  const down = () => {
    opening = false;
    if (ws === w) ws = null;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 15000);
  };
  w.onclose = down;
  w.onerror = down;
}

/** 订阅目录变更；返回退订函数（引用计数，多组件可叠加同一目录） */
export function watchDir(dir: string): () => void {
  connect();
  want.set(dir, (want.get(dir) || 0) + 1);
  sync();
  return () => {
    const n = (want.get(dir) || 1) - 1;
    if (n <= 0) want.delete(dir); else want.set(dir, n);
    sync();
  };
}

/** 注册文件变更回调（dirs = 本次有变化的目录集合） */
export function useFsEvent(cb: Cb) {
  useEffect(() => {
    connect();
    cbs.add(cb);
    return () => { cbs.delete(cb); };
  }, [cb]);
}
