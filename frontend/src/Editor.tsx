// 中栏：VSCode 风格编辑器（文件 Tab + CodeMirror 编辑 + 图片/SVG/HTML/Markdown/PDF 预览 + Ctrl+S 保存）
import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "./lib/api";
import { FileText, Save, X, Circle, Image as ImageIcon, Eye, Pencil, ZoomIn, ZoomOut, RotateCcw, ListX, TriangleAlert } from "lucide-react";
import { Streamdown } from "streamdown";
import { cn, dispPath } from "@/lib/utils";
import { useFsEvent, watchDir } from "@/lib/fswatch";
import CodeField from "./CodeField";

interface Tab {
  path: string;
  name: string;
  original: string;
  content: string;
  binary: boolean;
  size: number;
  loading: boolean;
  saving: boolean;
  error?: string;
  /** 编辑中有磁盘新版本（冲突未决） */
  conflict?: boolean;
  /** 冲突时的磁盘内容 */
  diskContent?: string;
  /** 文件已被删除（外部删除；保留 Tab 由用户决定去留，保存 = 重建） */
  deleted?: boolean;
}

// 文件形态分类：位图/PDF 仅预览；svg/html/md 预览⇄源码可切（svg=html 高亮编辑）；其余按文本编辑
type Kind = "image" | "svg" | "html" | "md" | "pdf" | "text";
function kindOf(path: string): Kind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"].includes(ext)) return "image";
  if (ext === "svg") return "svg";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "pdf") return "pdf";
  return "text";
}

// 图片预览：拉原始字节转 blob URL（svg 经 <img> 渲染天然不执行脚本），卸载即回收。
// transform 平移/缩放模型：图片自然尺寸居中，translate+scale 自由变换——无滚动条、
// 无边界钳制（放大后四周都能铺出去），滚轮以光标为锚点缩放，拖拽平移。
function RawImg({ path, scale = 1, onZoom }: { path: string; scale?: number; onZoom?: (z: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [grabbing, setGrabbing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(scale); zoomRef.current = scale;
  const panRef = useRef(pan); panRef.current = pan; // 滚轮锚点计算读最新值

  useEffect(() => {
    let u: string | null = null, dead = false;
    setErr(""); setUrl(null);
    fetch(`${API}/fs/raw?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((b) => { if (dead) return; u = URL.createObjectURL(b); setUrl(u); })
      .catch((e) => !dead && setErr(String(e)));
    return () => { dead = true; if (u) URL.revokeObjectURL(u); };
  }, [path]);

  // 仅换图时归位（缩放回到 100% 不重置平移——否则滚轮 0.25 步进经常恰好踩回 1.0，
  // 把用户拖好的位置弹回中心，像"100% 时拖不动"）
  useEffect(() => { setPan({ x: 0, y: 0 }); }, [path]);

  // 滚轮缩放（光标锚定）：t' = p - (p - t)·s'/s，保持光标下的图像点不动。
  // React onWheel 是 passive 的，preventDefault 需原生非 passive 监听。
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !onZoom) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const s0 = zoomRef.current;
      const s1 = Math.min(32, Math.max(0.25, s0 + (e.deltaY < 0 ? 0.25 : -0.25)));
      if (s1 === s0) return;
      const rc = el.getBoundingClientRect();
      const px = e.clientX - rc.left - rc.width / 2;
      const py = e.clientY - rc.top - rc.height / 2;
      const t = panRef.current;
      setPan({ x: px - (px - t.x) * (s1 / s0), y: py - (py - t.y) * (s1 / s0) });
      onZoom(s1);
    };
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [onZoom, url]); // url 进 deps：首渲染是"加载中"分支（boxRef 空），图片就位后须重新挂监听

  // 抓取平移：拖拽直接改 translate（无边界，任意方向）。
  // 防监听泄漏三保险：buttons 自愈（漏掉 mouseup 时下一次移动即停）+ 窗口 blur 清理 + 幂等 done
  const startPan = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    let lx = e.clientX, ly = e.clientY;
    let dead = false;
    const move = (ev: MouseEvent) => {
      if (!ev.buttons) { done(); return; } // 松开后仍在移动 = 曾漏 mouseup，自愈
      // delta 必须先算成 const：React 18 延迟执行函数式 updater，
      // 若在 updater 里读 lx/ly，闭包变量已被改写，delta 恒为 0（拖不动）
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      lx = ev.clientX; ly = ev.clientY;
      setPan((t) => ({ x: t.x + dx, y: t.y + dy }));
    };
    const up = () => done();
    const done = () => {
      if (dead) return; dead = true;
      setGrabbing(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("blur", done);
    };
    setGrabbing(true);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("blur", done);
  };

  if (err) return <div className="flex h-full items-center justify-center text-xs text-destructive">图片加载失败：{err}</div>;
  if (!url) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">图片加载中…</div>;
  return (
    <div ref={boxRef} onMouseDown={startPan}
      title="滚轮缩放 · 拖拽平移"
      className={cn("flex h-full w-full items-center justify-center overflow-hidden bg-muted/30",
        onZoom && "cursor-grab", grabbing && "cursor-grabbing")}>
      <img src={url} alt={path} draggable={false}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        className="max-w-none select-none pointer-events-none" />
    </div>
  );
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// PDF 预览：拉原始字节转 blob URL 塞 <iframe>——浏览器内置阅读器渲染（翻页/缩放/打印全免实现）。
// 与图片同款 rev 重挂：磁盘上文件被改后自动换新 URL 重载。
function RawPdf({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let u: string | null = null, dead = false;
    setErr(""); setUrl(null);
    fetch(`${API}/fs/raw?path=${encodeURIComponent(path)}`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob(); })
      .then((b) => { if (dead) return; u = URL.createObjectURL(b); setUrl(u); })
      .catch((e) => !dead && setErr(String(e)));
    return () => { dead = true; if (u) URL.revokeObjectURL(u); };
  }, [path]);
  if (err) return <div className="flex h-full items-center justify-center text-xs text-destructive">PDF 加载失败：{err}</div>;
  if (!url) return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">PDF 加载中…</div>;
  return <iframe title={path} src={url} className="h-full w-full border-0 bg-white" />;
}

export default function Editor({
  openReq, movedReq, onOpened, onClose,
}: {
  openReq: { path: string; pinned: boolean; seq: number } | null;
  /** 树内移动/重命名通知:tabs 路径跟随(不标已删除),active/preview/视图状态键一并迁移 */
  movedReq: { moves: [string, string][]; seq: number } | null;
  onOpened?: () => void;
  onClose?: () => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // VSCode 预览标签 + 热打开：距上次打开 ≤1s 视为快速浏览，复用预览标签（斜体）原地替换；
  // >1s（已停留过）则上次的预览自动转正（去斜体=钉住），本次开新预览标签。双击/编辑仍立即转正。
  const [preview, setPreview] = useState<string | null>(null);
  // html/md/svg 预览⇄源码切换（按路径记）；图片缩放（按路径记，1=自然尺寸）
  const [srcMode, setSrcMode] = useState<Record<string, boolean>>({});
  const [imgZoom, setImgZoom] = useState<Record<string, number>>({});
  const lastOpenAt = useRef(0);
  // 激活 tab 滚动进视窗（tab 多时激活项可能在滚动区外，点击/打开都应可见）
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }, [active]);

  // 移动/重命名跟随:命中 moves.from 的 tab 路径改写(to),清 deleted;派生键(active/preview/srcMode/imgZoom)迁移
  useEffect(() => {
    if (!movedReq?.moves.length) return;
    const map = new Map(movedReq.moves);
    // 前缀感知:改上级目录名时,其下打开的文件(路径前缀命中)一并跟随
    const remap = (p: string) => {
      const exact = map.get(p);
      if (exact) return exact;
      for (const [f, t] of map) if (p.startsWith(f + "/")) return t + p.slice(f.length);
      return p;
    };
    setTabs((ts) => ts.map((t) => {
      const to = remap(t.path);
      return to !== t.path ? { ...t, path: to, name: to.split("/").pop() || t.name, deleted: false } : t;
    }));
    setActive((a) => (a ? remap(a) : a));
    setPreview((pv) => (pv ? remap(pv) : pv));
    setSrcMode((m) => { const o: Record<string, boolean> = {}; for (const [k, v] of Object.entries(m)) o[remap(k)] = v; return o; });
    setImgZoom((z) => { const o: Record<string, number> = {}; for (const [k, v] of Object.entries(z)) o[remap(k)] = v; return o; });
  }, [movedReq?.seq]);

  // 刷新恢复：从 localStorage 读上次打开的文件列表，重建 tabs 并逐个拉取内容
  // （内容以磁盘为准重新加载，未保存的修改不持久化）
  // 必须定义在"打开请求"effect 之前：chat-first 布局编辑器默认卸载、点文件才挂载，
  // 挂载那一拍若本恢复 effect 排在后（replace 覆盖 append）会把刚点的文件吞掉；
  // 排在前则打开 effect 的幂等兜底（updater 内查重）保证同文件不重复开
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("qweb.tabs") || "null");
      if (saved && Array.isArray(saved.paths) && saved.paths.length) {
        setTabs(saved.paths.map((p: string) => ({
          path: p, name: p.split("/").pop() || p, original: "", content: "",
          binary: false, size: 0, loading: true, saving: false,
        })));
        setActive(saved.active && saved.paths.includes(saved.active) ? saved.active : saved.paths[saved.paths.length - 1]);
        if (saved.preview && saved.paths.includes(saved.preview)) setPreview(saved.preview);
        for (const p of saved.paths) {
          fetch(`${API}/fs/file?path=${encodeURIComponent(p)}`)
            .then((r) => r.json())
            .then((d) => setTabs((ts) => ts.map((t) => t.path === p
              ? { ...t, loading: false, binary: !!d.binary, size: d.size ?? 0,
                  original: d.content ?? "", content: d.content ?? "",
                  error: d.error ? String(d.error) : undefined }
              : t)))
            .catch(() => setTabs((ts) => ts.map((t) => t.path === p ? { ...t, loading: false, error: "网络错误" } : t)));
        }
      }
    } catch {}
  }, []);

  // 外部请求打开文件（seq 变化即触发，同路径重复请求用于钉住）
  useEffect(() => {
    if (!openReq) return;
    const { path, pinned } = openReq;
    if (tabs.some((t) => t.path === path)) {
      setActive(path);
      if (pinned) setPreview((p) => (p === path ? null : p));
      return;
    }
    const hot = !pinned && Date.now() - lastOpenAt.current <= 1000;
    lastOpenAt.current = Date.now();
    const name = path.split("/").pop() || path;
    const tab: Tab = { path, name, original: "", content: "", binary: false, size: 0, loading: true, saving: false };
    setTabs((ts) => {
      // 幂等兜底：上面的闭包查重用的是本拍渲染的 tabs（挂载竞跑/连点时是旧值），
      // updater 里再查一道——同路径绝不重复入列
      if (ts.some((t) => t.path === path)) return ts;
      // 热打开：替换现有预览标签的原位置（不新增 tab）；冷打开/pinned 追加新 tab
      const i = hot ? ts.findIndex((t) => t.path === preview) : -1;
      if (i >= 0) { const next = [...ts]; next[i] = tab; return next; }
      return [...ts, tab];
    });
    if (!pinned) setPreview(path);
    setActive(path);
    fetch(`${API}/fs/file?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => {
        setTabs((ts) => ts.map((t) => t.path === path
          ? { ...t, loading: false, binary: !!d.binary, size: d.size ?? 0,
              original: d.content ?? "", content: d.content ?? "",
              error: d.error ? String(d.error) : undefined }
          : t));
        onOpened?.();
      })
      .catch(() => setTabs((ts) => ts.map((t) => t.path === path ? { ...t, loading: false, error: "网络错误" } : t)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReq?.seq]);

  // tabs 变化即持久化（挂载时的空态写入会被恢复后的重渲染立即覆盖，无碍）
  useEffect(() => {
    try {
      localStorage.setItem("qweb.tabs", JSON.stringify({
        paths: tabs.map((t) => t.path), active, preview,
      }));
    } catch {}
  }, [tabs, active, preview]);

  const cur = tabs.find((t) => t.path === active) || null;
  const dirty = cur ? cur.content !== cur.original : false;
  const kind = cur ? kindOf(cur.path) : "text";
  const asSource = !!cur && (srcMode[cur.path] || (kind === "text")); // text 恒为源码态

  // 编辑回调：更新内容 + 预览标签转正
  const editContent = useCallback((v: string) => {
    if (!cur) return;
    setTabs((ts) => ts.map((t) => t.path === cur.path ? { ...t, content: v } : t));
    if (preview === cur.path) setPreview(null);
  }, [cur, preview]);

  const save = useCallback(async () => {
    if (!cur || !dirty || cur.saving || cur.binary || kindOf(cur.path) === "image") return;
    setTabs((ts) => ts.map((t) => t.path === cur.path ? { ...t, saving: true } : t));
    try {
      const r = await fetch(`${API}/fs/file`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: cur.path, content: cur.content }),
      });
      const d = await r.json();
      setTabs((ts) => ts.map((t) => t.path === cur.path
        ? { ...t, saving: false, error: r.ok ? undefined : d.error,
           original: r.ok ? t.content : t.original,
           deleted: r.ok ? false : t.deleted } // 保存成功 = 文件已重建
        : t));
    } catch {
      setTabs((ts) => ts.map((t) => t.path === cur.path ? { ...t, saving: false, error: "网络错误" } : t));
    }
  }, [cur, dirty]);

  // Ctrl+S（焦点不在 Monaco 时也生效；Monaco 内部另有绑定）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save]);

  const closeTab = (p: string) => {
    if (preview === p) setPreview(null);
    setTabs((ts) => {
      const next = ts.filter((t) => t.path !== p);
      if (active === p) setActive(next.length ? next[Math.max(0, ts.findIndex((t) => t.path === p) - 1)]?.path ?? null : null);
      return next;
    });
  };

  // Tab 右键菜单（关闭 / 全部关闭）
  const [ctx, setCtx] = useState<{ x: number; y: number; path: string } | null>(null);
  useEffect(() => {
    if (!ctx) return;
    const h = () => setCtx(null);
    window.addEventListener("mousedown", h);
    window.addEventListener("contextmenu", h);
    window.addEventListener("blur", h);
    return () => {
      window.removeEventListener("mousedown", h);
      window.removeEventListener("contextmenu", h);
      window.removeEventListener("blur", h);
    };
  }, [ctx]);
  const closeAll = () => { setTabs([]); setActive(null); setPreview(null); };
  // 最后一个 tab 关掉（单个关/全部关）后自动收起编辑器面板；空面板打开不触发（hadTabs 守卫）
  const hadTabs = useRef(false);
  useEffect(() => {
    if (tabs.length) hadTabs.current = true;
    else if (hadTabs.current) onClose?.();
    hadTabs.current = tabs.length > 0;
  }, [tabs.length]);

  const zoom = cur ? imgZoom[cur.path] ?? 1 : 1;
  const setZoom = (z: number) => cur && setImgZoom((m) => ({ ...m, [cur.path]: Math.min(32, Math.max(0.25, z)) }));
  const isImgView = !!cur && !cur.loading && (kind === "image" || (kind === "svg" && !asSource));

  // ---- 磁盘变更自动同步（零轮询）：订阅打开文件所在目录，事件按 tab 合并 ----
  // 非编辑态直接换内容（live reload）；编辑中且内容确有分叉 → 标冲突横幅（磁盘版/保留我的二选一）。
  // 图片/SVG 预览走 rev 重挂（RawImg 只在挂载时拉取）。
  const dirsOf = (p: string) => { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); };
  const tabDirsKey = [...new Set(tabs.map((t) => dirsOf(t.path)))].join("\n");
  useEffect(() => {
    const un = tabDirsKey ? tabDirsKey.split("\n").map((d) => watchDir(d)) : [];
    return () => un.forEach((f) => f());
  }, [tabDirsKey]);
  const [revs, setRevs] = useState<Record<string, number>>({});
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  useFsEvent(useCallback((dirs) => {
    const set = new Set(dirs);
    for (const t of tabsRef.current) {
      if (!set.has(dirsOf(t.path))) continue;
      if (t.binary || kindOf(t.path) === "image") {
        setRevs((m) => ({ ...m, [t.path]: (m[t.path] || 0) + 1 }));
        continue;
      }
      fetch(`${API}/fs/file?path=${encodeURIComponent(t.path)}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.error) {
            // 文件被外部删除（claude/终端/别的进程）：保留 Tab 并标记（VSCode 默认行为）——
            // 直接关会无预警丢掉未保存内容；保存 = 重建文件，关闭交给用户
            if (/ENOENT|no such/i.test(String(d.error)))
              setTabs((ts) => ts.map((x) => x.path === t.path ? { ...x, deleted: true } : x));
            return;
          }
          if (d.binary) return;
          setTabs((ts) => ts.map((x) => {
            if (x.path !== t.path) return x;
            const base = { ...x, deleted: false }; // 文件又回来了（重建/撤销）
            const disk = d.content ?? "";
            if (x.content === x.original) return { ...base, original: disk, content: disk, size: d.size ?? 0, conflict: false, diskContent: undefined };
            return x.content === disk ? { ...base, original: disk, conflict: false, diskContent: undefined } : { ...base, conflict: true, diskContent: disk };
          }));
        }).catch(() => {});
    }
  }, []));
  // 冲突裁决：磁盘版 = 内容对齐磁盘；保留我的 = 只挪 original 基线（保存即覆盖磁盘）
  const resolveConflict = (p: string, take: "disk" | "mine") => setTabs((ts) => ts.map((x) => x.path !== p ? x : (() => {
    const disk = x.diskContent ?? x.original;
    return take === "disk" ? { ...x, content: disk, original: disk, size: disk.length, conflict: false, diskContent: undefined }
                           : { ...x, original: disk, conflict: false, diskContent: undefined };
  })()));

  return (
    // min-h-0：chat-first 浮层 wrapper 是列向 flex，本根是其主轴子项——不钳的话
    // min-height:auto 会被 CM 长文档顶破浮层高度（旧布局走交叉轴 stretch 无此问题）
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Tab 栏（tabs 区可滚动，X 关闭钮固定右侧不随滚动） */}
      <div className="flex h-9 shrink-0 items-stretch bg-card/40">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {tabs.map((t) => {
            const d = t.content !== t.original;
            const Icon = (kindOf(t.path) === "image" || kindOf(t.path) === "svg") ? ImageIcon : FileText;
            return (
              <div key={t.path}
                ref={active === t.path ? activeTabRef : null}
                className={cn(
                  "group relative flex min-w-28 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/60 px-3 text-xs",
                  active === t.path
                    ? "bg-primary/[0.08] font-medium text-foreground"
                    : "text-muted-foreground hover:bg-background/50"
                )}
                onClick={() => setActive(t.path)}
                onDoubleClick={() => setPreview((p) => (p === t.path ? null : p))}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ x: e.clientX, y: e.clientY, path: t.path }); }}
                title={t.path === preview ? "预览标签（双击钉住 / 停留超 1s 后自动转正）" : dispPath(t.path)}>
                {/* 激活指示条（VSCode 式顶部主色边）：绝对定位不占布局，切换 tab 无跳动 */}
                {active === t.path && <span className="absolute inset-x-0 top-0 h-[2.5px] rounded-b-sm bg-primary" />}
                <Icon className={cn("h-3 w-3 shrink-0", active === t.path ? "text-primary" : "opacity-70")} />
                <span className={cn("truncate", t.path === preview && "italic", t.deleted && "line-through text-destructive/80")}>{t.name}</span>
                <span className="ml-auto flex items-center">
                  {d ? <Circle className="h-2 w-2 fill-current text-primary" /> : <span className="w-2" />}
                  {/* X：active 常显（VS Code 语义）——窄编辑区 tab 拥挤滚动时，hover 才
                      现形的关闭钮根本找不到；非 active 保持悬停显现（视觉降噪） */}
                  <X className={cn("h-3 w-3 rounded p-0.5 text-foreground/70 hover:bg-accent",
                    active === t.path ? "opacity-100" : "opacity-0 group-hover:opacity-70")}
                    onClick={(e) => { e.stopPropagation(); closeTab(t.path); }} />
                </span>
              </div>
            );
          })}
          {!tabs.length && <div className="flex items-center px-4 text-xs text-muted-foreground/50">编辑器</div>}
        </div>
        {onClose && (
          <button
            className="flex w-8 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭面板" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Tab 右键菜单（原生元素无组件引用问题；stopPropagation 防自身事件冒泡到 window 关菜单） */}
      {ctx && (
        <div
          className="fixed z-50 min-w-36 rounded-md border border-border bg-popover py-1 text-xs shadow-xl"
          style={{ left: Math.min(ctx.x, window.innerWidth - 150), top: Math.min(ctx.y, window.innerHeight - 90) }}
          onContextMenu={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}>
          <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
            onClick={() => { closeTab(ctx.path); setCtx(null); }}>
            <X className="h-3 w-3 opacity-70" />关闭
          </button>
          <button className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
            onClick={() => { closeAll(); setCtx(null); }}>
            <ListX className="h-3 w-3 opacity-70" />全部关闭
          </button>
        </div>
      )}

      {/* 工具条：左侧保存，编辑⇄预览切换，图片缩放；删除/磁盘冲突横幅 */}
      {cur && cur.deleted && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-2 text-[0.6875rem] text-destructive">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">文件已被删除（外部操作）——保存将重新创建，或关闭标签放弃</span>
          <button className="ml-auto shrink-0 rounded px-2 py-0.5 hover:bg-destructive/20"
            onClick={() => closeTab(cur.path)}>关闭标签</button>
        </div>
      )}
      {cur && cur.conflict && (
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-2 text-[0.6875rem] text-amber-600">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">文件已在磁盘上被修改，与你的未保存编辑冲突</span>
          <button className="ml-auto shrink-0 rounded px-2 py-0.5 hover:bg-amber-500/20"
            onClick={() => resolveConflict(cur.path, "disk")}>用磁盘版</button>
          <button className="shrink-0 rounded px-2 py-0.5 hover:bg-amber-500/20"
            onClick={() => resolveConflict(cur.path, "mine")}>保留我的</button>
        </div>
      )}
      {cur && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/40 px-2 text-[0.6875rem] text-muted-foreground">
          <button
            className={cn("flex items-center gap-1 rounded px-2 py-1 hover:bg-accent disabled:opacity-40",
              dirty && !cur.binary && kind !== "image" && "text-foreground")}
            disabled={!dirty || cur.binary || cur.saving || kind === "image"}
            onClick={save} title="Ctrl+S">
            <Save className="h-3.5 w-3.5" />{cur.saving ? "保存中…" : "保存"}
          </button>
          <div className="mx-1 h-4 w-px bg-border/60" />
          {(kind === "html" || kind === "md" || kind === "svg") && !cur.binary && (
            <button
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-accent"
              onClick={() => setSrcMode((m) => ({ ...m, [cur.path]: !m[cur.path] }))}>
              {asSource ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
              {asSource ? "预览" : "编辑"}
            </button>
          )}
          {isImgView && (
            <div className="flex items-center gap-0.5">
              <button className="rounded p-1 hover:bg-accent" title="缩小"
                onClick={() => setZoom(zoom - 0.25)}><ZoomOut className="h-3.5 w-3.5" /></button>
              <span className="w-11 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <button className="rounded p-1 hover:bg-accent" title="放大"
                onClick={() => setZoom(zoom + 0.25)}><ZoomIn className="h-3.5 w-3.5" /></button>
              <button className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent" title="还原 100%"
                onClick={() => setZoom(1)}><RotateCcw className="h-3 w-3" />100%</button>
            </div>
          )}
        </div>
      )}

      {/* 内容区（min-h-0：flex 子项默认 min-height:auto 会被 CM 长文档撑破视口且无处滚动） */}
      <div className="relative min-h-0 flex-1">
        {!cur && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
            从左侧资源管理器打开文件
          </div>
        )}
        {cur?.loading && <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中…</div>}
        {cur && !cur.loading && kind === "image" && <RawImg key={`img-${revs[cur.path] || 0}`} path={cur.path} scale={zoom} onZoom={setZoom} />}
        {/* svg 默认图片预览（可切源码）；即使超大被标记 binary 也仍可看 */}
        {cur && !cur.loading && kind === "svg" && !asSource && <RawImg key={`svg-${revs[cur.path] || 0}`} path={cur.path} scale={zoom} onZoom={setZoom} />}
        {/* pdf 走内置阅读器（binary 标记不影响预览） */}
        {cur && !cur.loading && kind === "pdf" && <RawPdf key={`pdf-${revs[cur.path] || 0}`} path={cur.path} />}
        {cur && !cur.loading && kind !== "image" && kind !== "svg" && kind !== "pdf" && cur.binary && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            二进制文件（{cur.size} B），不支持编辑
          </div>
        )}
        {cur && !cur.loading && !cur.binary && asSource && (
          <CodeField key={cur.path} path={cur.path} value={cur.content}
            onChange={editContent} onSave={save} />
        )}
        {cur && !cur.loading && !cur.binary && !asSource && kind === "html" && (
          <iframe title={cur.path} srcDoc={cur.content} sandbox="allow-scripts"
            className="h-full w-full border-0 bg-white" />
        )}
        {cur && !cur.loading && !cur.binary && !asSource && kind === "md" && (
          <div className="sd h-full w-full overflow-y-auto p-6">
            <Streamdown>{cur.content}</Streamdown>
          </div>
        )}
      </div>

      {/* 状态栏：路径/大小/未保存/错误 */}
      {cur && (
        <div className="flex h-6 shrink-0 items-center gap-2 border-t border-border/40 bg-card/30 px-3 text-[0.625rem] text-muted-foreground">
          <span className="min-w-0 truncate font-mono" title={dispPath(cur.path)}>{dispPath(cur.path)}</span>
          <span className="shrink-0">{fmtSize(cur.size)}</span>
          {dirty && <span className="shrink-0 text-amber-500">未保存</span>}
          {cur.error && <span className="ml-auto max-w-[50%] shrink-0 truncate text-destructive" title={cur.error}>{cur.error}</span>}
        </div>
      )}
    </div>
  );
}
