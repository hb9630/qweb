// ccweb 主界面：对话主导（chat-first）——对话铺满全宽做底层，其头部升格为全局标题栏；
// 左上三件套：cwd chip 开关目录树浮层 / ▾ 历史工作目录 / 换目录选择器（见 ChatPanel）。
// 目录树浮层从标题栏下方垂到底（左缘贴边），编辑器浮层紧贴其右——两者各自头部有 X
// 独立关闭（相当于把原三栏的树/编辑器搬到标题栏下面浮起）；编辑器最后一个 tab
// 关闭仍自动收编辑器（Editor 既有语义）。手机/桌面同一结构（浮层宽 clamp 到 vw）。
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { API, hashSid, setHashSid } from "./lib/api";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import Explorer from "./Explorer";
import Editor from "./Editor";
import ChatPanel from "./ChatPanel";

interface LiveSession { id: string; cwd: string; claudeSid?: string | null; engine?: string | null }

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function Resizer({ onDrag, lineAt = "-left-px" }: { onDrag: (dx: number) => void; lineAt?: string }) {
  const [active, setActive] = useState(false);
  const last = useRef(0);
  const down = (e: React.MouseEvent) => {
    setActive(true);
    last.current = e.clientX;
    const move = (ev: MouseEvent) => { onDrag(ev.clientX - last.current); last.current = ev.clientX; };
    const up = () => {
      setActive(false);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };
  return (
    // 浮层边缘调宽把手：纯命中区（透明底），可见的分割线由浮层自身 border 承担；
    // hover/拖动时高亮线精确压在同一条 border 上（lineAt：右缘缝压 -left-px 的 border-r，
    // 树|编辑器缝压 left-0 的编辑器 border-l——差 1px 就会看成"两根线"）。
    // h-full 由外层绝对定位容器（top-8 bottom-0，高度确定）撑起。
    <div onMouseDown={down} className="group relative z-10 h-full w-1.5 shrink-0 cursor-col-resize">
      <div
        className={cn("pointer-events-none absolute inset-y-0 w-px bg-foreground/70 opacity-0 transition-opacity group-hover:opacity-100", lineAt)}
        style={active ? { background: "oklch(var(--primary))", opacity: 1 } : undefined}
      />
    </div>
  );
}

export default function App() {
  // 工作目录记忆：用户设定过（localStorage）则刷新后沿用，不再跟会话 cwd 走。
  // 默认值不硬编码（ccweb 不总在容器里，HOME 不一定是 /root）：未知时用上次
  // env 下发的 HOME 缓存（ccweb.home——首访后刷新零等待，无"未设定"窗口），仍未知则空，
  // 等 /api/env 下发 HOME 后由 env effect 设定
  const savedRoot = (() => { try { return localStorage.getItem("ccweb.root"); } catch { return null; } })();
  const cachedHome = (() => { try { return localStorage.getItem("ccweb.home"); } catch { return null; } })();
  const userRoot = useRef(!!savedRoot);
  const [root, setRoot] = useState<string>(savedRoot || cachedHome || "");
  // 打开文件请求：seq 递增保证同路径重复请求也触发（双击=钉住已开的预览）
  const [openReq, setOpenReq] = useState<{ path: string; pinned: boolean; seq: number } | null>(null);
  // 文件移动/重命名通知(树 → 编辑器):tabs 路径跟随,不再标"已删除"
  const [movedReq, setMovedReq] = useState<{ moves: [string, string][]; seq: number } | null>(null);
  const onMoved = (moves: [string, string][]) => {
    setMovedReq({ moves, seq: Date.now() });
    setOpenReq((r) => {
      if (!r) return r;
      // 前缀感知:上级目录改名时,其下打开的文件一并跟随
      let p = r.path;
      for (const [f, t] of moves) {
        if (p === f) { p = t; break; }
        if (p.startsWith(f + "/")) { p = t + p.slice(f.length); break; }
      }
      return p === r.path ? r : { ...r, path: p };
    });
  };
  const openFile = (path: string, pinned?: boolean) => {
    setOpenReq((r) => ({ path, pinned: !!pinned, seq: (r?.seq ?? 0) + 1 }));
    setShowEditor(true); // 编辑器被整组关掉后，点文件应重新弹出浮层（树不联动收起——浮层组一体）
  };
  const [groups, setGroups] = useState<any[]>([]);
  const [live, setLive] = useState<LiveSession | null>(null);
  const [histEv, setHistEv] = useState<{ id: string; cwd: string; events: any[]; resumeSid: string | null; model?: string | null } | null>(null);
  const [pending, setPending] = useState<{ events: any[]; text: string; model?: string | null } | null>(null);
  const [booted, setBooted] = useState(false);
  // 会话恢复中（挂载→重连/自动 resume 的窗口期）：显示"正在恢复"而非"（空会话）"，
  // 后端未就绪时靠 bootTick 重试直到成功
  const [restoring, setRestoring] = useState(true);
  const [bootTick, setBootTick] = useState(0);
  // 布局持久化：浮层组开合与宽度刷新后保持（localStorage）；默认全关 = 纯对话第一印象
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem("ccweb.layout") || "{}"); }
    catch { return {}; }
  })();
  const [wTree, setWTree] = useState(saved.wTree ?? 280);
  const [wEditor, setWEditor] = useState(saved.wEditor ?? Math.min(720, Math.round(window.innerWidth * 0.46)));
  const [showTree, setShowTree] = useState(saved.showTree ?? false);
  const [showEditor, setShowEditor] = useState(saved.showEditor ?? false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/history`);
      setGroups(await r.json());
    } catch {}
  }, []);
  useEffect(() => { refresh().then(() => setBooted(true)); }, [refresh]);
  useEffect(() => {
    localStorage.setItem("ccweb.layout",
      JSON.stringify({ showTree, showEditor, wTree, wEditor }));
  }, [showTree, showEditor, wTree, wEditor]);
  useEffect(() => { if (!live) setPending(null); }, [live]);
  // 任何路径（含手动新会话/打开历史）就位即清除"恢复中"
  useEffect(() => { if (live || histEv) setRestoring(false); }, [live, histEv]);
  // 会话锚点同步（live 已知 claudeSid 的路径：resume/重连/历史回放；新会话 init 到达
  // 后由 ChatPanel 侧补写）。只在有会话时写——启动窗口（live/histEv 均 null）绝不能清：
  // 本 effect 挂载时先于 boot 跑，清了锚点 boot 就只能走"最新会话"启发式
  useEffect(() => {
    const sid = live?.claudeSid ?? histEv?.id ?? null;
    if (sid) setHashSid(sid);
  }, [live, histEv]);

  // 全局字号：Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置（改 html font-size 基准，UI 均为 rem 等比缩放）
  const [fsTip, setFsTip] = useState<number | null>(null);
  const fsTimer = useRef<number>(0);
  useEffect(() => {
    const apply = (px: number, tip: boolean) => {
      document.documentElement.style.fontSize = px + "px";
      localStorage.setItem("ccweb.fontSize", String(px));
      if (tip) { setFsTip(px); clearTimeout(fsTimer.current); fsTimer.current = window.setTimeout(() => setFsTip(null), 1200); }
    };
    const saved = Number(localStorage.getItem("ccweb.fontSize"));
    if (saved >= 12 && saved <= 24 && saved !== 18) apply(saved, false); // 恢复记忆（18=默认，见 index.css 基准）
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const cur = Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize)) || 18;
      const k = e.key;
      if (k === "=" || k === "+") { e.preventDefault(); apply(Math.min(24, cur + 1), true); }
      else if (k === "-" || k === "_") { e.preventDefault(); apply(Math.max(12, cur - 1), true); }
      else if (k === "0") { e.preventDefault(); apply(18, true); }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); clearTimeout(fsTimer.current); };
  }, []);

  // 工作区根 = 环境 HOME（后端 /api/env 下发，不写死 /root；拉到前用 /root 兜底）
  const [home, setHome] = useState(""); // /api/env 到达前未知（不再默认 /root：宿主机形态 HOME 各异）
  const [envModels, setEnvModels] = useState<string[]>([]);
  // 引擎清单（/api/env 下发；qtom 在后端配了 --dsweb 才出现）与偏好（下次新会话用）
  const [engines, setEngines] = useState<{ id: string; label: string }[]>([]);
  const [enginePref, setEnginePref] = useState<string>(() => {
    try { return localStorage.getItem("ccweb.engine") || "claude"; } catch { return "claude"; }
  });
  const onEnginePref = (id: string) => {
    setEnginePref(id);
    try { localStorage.setItem("ccweb.engine", id); } catch {}
  };
  useEffect(() => {
    fetch(`${API}/env`).then((r) => r.json())
      .then((d: any) => {
        if (typeof d.home === "string" && d.home) {
          setHome(d.home);
          try { localStorage.setItem("ccweb.home", d.home); } catch {} // 下次打开零等待兜底
          if (!userRoot.current) setRoot(d.home); // 从未人工设定过才用 home 兜底
        }
        if (Array.isArray(d.models)) setEnvModels(d.models.map(String));
        if (Array.isArray(d.engines)) {
          // qtom 通道下线（DeepSeek 账号风控）：前端入口隐藏；后端接入/历史会话兼容全保留
          const list = d.engines.filter((e: any) => e.id !== "qtom");
          setEngines(list);
          setEnginePref(prev => (list.some((e: any) => e.id === prev) ? prev : "claude")); // 偏好残留回落
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!booted || live || histEv) return;
    (async () => {
      // 0) URL 锚点优先：#s=<sid> 精确恢复该会话（多 tab 各自钉住、重启后精确回原对话）
      const want = hashSid();
      if (want) {
        try {
          const r = await fetch(`${API}/sessions`);
          const list = await r.json();
          const mine = (Array.isArray(list) ? list : []).find((x: any) => x.claude_sid === want);
          if (mine) {
            // 已有活进程：与下方"活会话重连"同款（n>0 靠 pre+buf 回放，n=0 拉 transcript 补）
            const attach = (d: any) => {
              if (d?.events?.length || d?.model) setPending({ events: d.events ?? [], text: "", model: d.model ?? null });
              else setPending(null);
              setLive({ id: mine.id, cwd: mine.cwd, claudeSid: mine.claude_sid ?? null, engine: mine.engine ?? "claude" });
              setRestoring(false);
            };
            if (mine.n > 0 || !mine.claude_sid) attach(null);
            else fetch(`${API}/history/${want}`).then((x) => x.json()).then(attach).catch(() => attach(null));
            return;
          }
          // 无活进程：拉历史 + resume（不带 cwd，服务端从 transcript 行内 cwd 推导）
          const [hr, pr] = await Promise.all([
            fetch(`${API}/history/${want}`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
            fetch(`${API}/sessions`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ resume: want }),
            }),
          ]);
          if (pr.ok) {
            const d = await pr.json();
            setPending({ events: hr?.events ?? [], text: "", model: hr?.model ?? null });
            setLive({ id: d.id, cwd: d.cwd, claudeSid: d.claudeSid ?? want, engine: d.engine ?? "claude" });
            setRestoring(false);
            refresh();
            return;
          }
          // resume 失败（原目录已删/进程起不来等）：锚点承诺"回到这个会话"——
          // 退到只读回放（cwd 从会话列表找），手动恢复仍可用；transcript 都没了才清锚点走常规
          if (hr) {
            const grp = groups.find((x: any) => x.sessions?.some((ss: any) => ss.id === want));
            openHistory(want, grp?.cwd ?? "");
            setRestoring(false);
            return;
          }
          setHashSid(null);
        } catch {
          // 后端未就绪（重启窗口）：保留锚点，2s 后重试
          setRestoring(true);
          setTimeout(() => setBootTick((t) => t + 1), 2000);
          return;
        }
      }
      // 1) server 上还有活会话（如刷新/重开标签页）→ 直接重连。
      //    必须同时取 transcript：后端 spawn 即投 /model 唤醒（见 sessions.rs），init ~1s 即发，
      //    但唤醒后 buf 只含 init+探测 result——对话历史仍需 transcript 补（n=0 时更是全靠它）
      try {
        const r = await fetch(`${API}/sessions`);
        const list = await r.json();
        if (Array.isArray(list) && list.length) {
          const s = [...list].sort((a: any, b: any) => b.startedAt - a.startedAt)[0];
          const attach = (d: any) => {
            // d=null（buf 已有全量）也必须清 pending——上一会话残留的初始事件会注入新面板
            if (d?.events?.length || d?.model) setPending({ events: d.events ?? [], text: "", model: d.model ?? null });
            else setPending(null);
            setLive({ id: s.id, cwd: s.cwd, claudeSid: s.claude_sid ?? null, engine: s.engine ?? "claude" });
            setRestoring(false);
            // 树不跟随会话 cwd（左树是目录唯一事实源，刷新只还原用户设定/HOME）
          };
          // n>0：进程已发过事件（唤醒后必为真：init+探测 result）——但那是刚 resume 的空 buf
          //    时 pre 帧才带历史；老会话 buf 回放即完整对话（再注 transcript 会渲染两份）
          // n=0：resume 进程唤醒尚未落地（1s 窗口内），需 transcript 补历史/模型/ctx
          if (s.n > 0 || !s.claude_sid) attach(null);
          else fetch(`${API}/history/${s.claude_sid}`).then((x) => x.json()).then(attach).catch(() => attach(null));
          return;
        }
      } catch {
        // 后端还没就绪（重启窗口）——2s 后重试，别停在"空会话"迷惑态
        setRestoring(true);
        setTimeout(() => setBootTick((t) => t + 1), 2000);
        return;
      }
      // 2) 无活会话（被空闲回收 / server 重启过）→ 自动 --resume 最近一次会话，刷新即回到可聊状态。
      //    挑"最近使用且有真实对话"的那个：空会话（刚建的、纯命令探测的）title 为空，跳过——
      //    否则 resume 到一个空 transcript，对话区就是空的。
      //    同时取 transcript 事件做 initialEvents（对话区立即有历史）+ model（init 要等首条消息才发）
      const last = groups.flatMap((g: any) => g.sessions.map((ss: any) => ({ ...ss, cwd: g.cwd })))
        .sort((a: any, b: any) => b.startedAt - a.startedAt);
      const g = last.find((x: any) => x.title) ?? last[0];
      if (g) {
        try {
          const [hr, r] = await Promise.all([
            fetch(`${API}/history/${g.id}`).then((x) => x.json()).catch(() => null),
            fetch(`${API}/sessions`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cwd: g.cwd, resume: g.id }),
            }),
          ]);
          const d = await r.json();
          if (r.ok) {
            setPending({ events: hr?.events ?? [], text: "", model: hr?.model ?? null });
            setLive({ id: d.id, cwd: d.cwd, claudeSid: d.claudeSid ?? g.id, engine: d.engine ?? "claude" });
            setRestoring(false);
            refresh();
            return;
          }
        } catch {}
        openHistory(g.id, g.cwd); // resume 失败兜底：只读历史（可手动恢复）
        setRestoring(false);
      } else {
        setRestoring(false); // 真没会话（全新环境）——"（空会话）"是真实状态
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, bootTick]);

  const newSession = async (cwd?: string) => {
    const r = await fetch(`${API}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: cwd ?? (root || home || "/"), engine: enginePref }),
    });
    const d = await r.json();
    if (!r.ok) return;
    setHistEv(null);
    setPending(null); // 清旧初始事件：否则新 ChatPanel 挂载时又注入上一会话的 transcript
    setHashSid(null); // 显式清锚点（sync effect 不写空值；init 到达后 ChatPanel 补写新 sid）
    setLive({ id: d.id, cwd: d.cwd, engine: d.engine ?? enginePref });
    refresh();
  };

  // 设为工作目录（唯一入口 = 标题栏三件套）：树切根 + 记忆（刷新沿用）+ 会话联动 + 记最近目录。
  // 语义（对用户可见的承诺）：换目录 = 新会话 = 新 claude 实例（cwd 在 spawn 时固化，长驻进程改不了）；
  // 旧会话消息在官方 transcript 里，历史列表可 resume 续聊；server 侧空闲 20min 自动回收进程。
  const pushRecent = (p: string) => {
    try {
      const cur = JSON.parse(localStorage.getItem("ccweb.recents") || "[]").filter((x: string) => x !== p);
      localStorage.setItem("ccweb.recents", JSON.stringify([p, ...cur].slice(0, 5)));
    } catch {}
  };
  const setWorkspace = (path: string) => {
    if (path === root) return;
    setRoot(path);
    userRoot.current = true;
    pushRecent(path);
    try { localStorage.setItem("ccweb.root", path); } catch {}
    // "目录树是左上角选择的结果"：选定即展开浮层（此前关着也开）
    setShowTree(true);
    // 提示走 toast（短暂浮现自动消失）；旧会话消息在官方 transcript，可 resume 续聊
    if (live && live.cwd !== path) {
      newSession(path);
      toast.success(`工作目录已切换到 ${path}`, { description: "已开启新会话（新 claude 实例）" });
    } else if (live) {
      toast.info(`工作目录 ${path} 与当前会话一致，继续当前会话`);
    }
  };

  const openHistory = async (id: string, cwd: string) => {
    try {
      const r = await fetch(`${API}/history/${id}`);
      const d = await r.json();
      if (!r.ok) return;
      // 历史 id 即官方 session_id（transcript 文件名），直接用于 --resume
      setWsNotice(null);
      setLive(null);
      setHistEv({ id, cwd, events: d.events, resumeSid: id, model: d.model ?? null });
    } catch {}
  };

  // 历史会话继续对话：--resume 恢复进程，历史消息保持显示，首条输入自动发出。
  // live.claudeSid = 历史的官方会话 ID → ChatPanel key 不变 → 面板不重挂，
  // 消息列表原地续聊（重挂会整列表重建 + 滚动重置，看起来"从头到尾重刷"）
  const resumeChat = async (text: string) => {
    if (!histEv) return;
    const r = await fetch(`${API}/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: histEv.cwd, resume: histEv.resumeSid }),
    });
    const d = await r.json();
    if (!r.ok) return;
    setPending({ events: histEv.events, text, model: histEv.model ?? null });
    setHistEv(null);
    setLive({ id: d.id, cwd: histEv.cwd, claudeSid: d.claudeSid ?? histEv.resumeSid, engine: d.engine ?? "claude" });
    refresh();
  };

  // ---- 浮层几何（与 return 里的渲染同源）：树宽/编辑器宽均 clamp 进视口，
  // 编辑器宽再让位树宽（两者合计不超屏）。chatInset 多让一格调宽把手宽
  // （w-1.5≈7px、不透明、z-30 在内容列之上——不让位会把输入框左缘压掉一条） ----
  const RESW = 8;
  const treeW = Math.min(wTree, window.innerWidth);
  const edLeft = showTree ? treeW : 0;
  const edW = Math.min(wEditor, Math.max(0, window.innerWidth - edLeft));
  const floatW = edLeft + (showEditor ? edW : 0) + ((showTree || showEditor) ? RESW : 0);

  const chatProps = {
    histGroups: groups,
    onNewSession: () => newSession(),
    onOpenHistory: openHistory, onRefreshHistory: refresh, onResume: resumeChat,
    root,
    models: envModels,
    engines, enginePref, onEnginePref,
    home, treeOpen: showTree, onToggleTree: () => setShowTree((v) => !v),
    onSwitchRoot: setWorkspace, chatInset: floatW,
  };

  const chat =
    live ? (
      // key 用官方会话 ID（resume 前后不变）：历史→resume 续聊不重挂面板；
      // 新会话（无 claudeSid）用 server 会话 ID
      <ChatPanel key={live.claudeSid ?? live.id} session={live} initialEvents={pending?.events} pendingText={pending?.text} initModel={pending?.model ?? undefined} {...chatProps} />
    ) : histEv ? (
      <ChatPanel key={histEv.id} historyEvents={histEv} initModel={histEv.model ?? undefined} {...chatProps} />
    ) : restoring ? (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在恢复会话…
      </div>
    ) : (
      <ChatPanel {...chatProps} />
    );

  // ---- 布局：对话铺底（含全局标题栏=ChatPanel 头部 h-8），树/编辑器浮层叠其上 ----
  // 树：left:0、标题栏下方(top-8)垂到底；编辑器：紧贴树右（树关时贴左边），树开合时整体平移。
  // 各自头部 X 独立关闭（树收/编辑器收互不影响）；编辑器"最后一个 tab 关闭→收面板"保留。
  return (
    <div className="relative h-screen w-screen overflow-hidden">
      {/* 对话底层：铺满全宽（标题栏在其中横贯顶部；浮层开时内容列经 chatInset 在可见区居中） */}
      <main className="absolute inset-0 flex flex-col">{chat}</main>

      {/* 目录树浮层：无 border-t（标题栏 border-b 已画那条线，再画会叠双线）；
          编辑器开着时右缝由编辑器 border-l 承担（树不再画 border-r），全缝单线。
          不加阴影：会向会话区单侧落灰（左右不对称），层次交给 1px 分割线 */}
      {showTree && (
        <div
          className={cn("absolute bottom-0 left-0 top-8 z-20 flex min-w-0 flex-col border-b border-border/70 bg-card",
            !showEditor && "border-r")}
          style={{ width: treeW }}>
          <Explorer root={root || home || "/"} home={home} onOpenFile={openFile} activeFile={openReq?.path ?? null} onMoved={onMoved}
            onClose={() => setShowTree(false)} />
        </div>
      )}
      {/* 树右缘把手：树开着就在（编辑器在场时压在树|编辑器缝上，仍可调树宽） */}
      {showTree && (
        <div className="absolute bottom-0 top-8 z-30" style={{ left: treeW }}>
          <Resizer lineAt={showEditor ? "left-0" : "-left-px"}
            onDrag={(dx) => setWTree((v) => clamp(v + dx, 190, 460))} />
        </div>
      )}

      {/* 编辑器浮层（紧贴树右；border-l 即树/编辑器之间唯一的缝） */}
      {showEditor && (
        <div
          className="absolute bottom-0 top-8 z-20 flex min-w-0 flex-col border-b border-r border-l border-border/70 bg-card"
          style={{ left: edLeft, width: edW }}>
          <Editor openReq={openReq} movedReq={movedReq} onClose={() => setShowEditor(false)} />
        </div>
      )}
      {showEditor && (
        <div className="absolute bottom-0 top-8 z-30" style={{ left: edLeft + edW }}>
          {/* 编辑器右缘把手：拖右加宽（旧三栏 v-dx 的方向语义在此相反）。
              上限：留给对话内容至少 320px 可见区（chatInset 随之收缩） */}
          <Resizer onDrag={(dx) => setWEditor((v) => clamp(v + dx, 360,
            Math.min(window.innerWidth * 0.7, window.innerWidth - edLeft - 320)))} />
        </div>
      )}

      {/* 字号提示（Ctrl+= / Ctrl+- / Ctrl+0） */}
      {fsTip !== null && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md border border-border/60 bg-card px-3 py-1.5 text-xs text-foreground/90 shadow-lg">
          字号 {fsTip}px <span className="text-muted-foreground">（Ctrl+0 重置）</span>
        </div>
      )}
    </div>
  );
}
