// 工作目录选择器（标题栏"切换工作目录"按钮弹出）：面包屑自由导航 + 目录列表 + 底部 ✓ 确认栏。
// 与目录树分工：树锁死在工作目录内部（浏览 = root），本选择器负责走出去挑新目录。
// POSIX：home 子树内 ~/ 相对、外面绝对路径。Windows：路径为盘符形态（C:/…），
//   不折叠 ~（直接绝对路径）；根页 =「电脑」列出所有盘符（/api/fs/dirs 根级返回 drives），
//   面包屑「电脑 / C: / Users / …」，点「电脑」或连按上一级可跨盘换目录。
// 单击目录 = 进入下一级；行尾 hover ✓ = 直选该目录（不进入）；底部 ✓ = 选定当前浏览层级。
import { useCallback, useEffect, useState } from "react";
import { API } from "./lib/api";
import { Check, ChevronUp, Folder, HardDrive, Loader2 } from "lucide-react";
import { cn, sameDir } from "@/lib/utils";

const isWinPath = (s: string) => /^[A-Za-z]:\//.test(s);

export const parentOfDir = (p: string): string | null => {
  if (p === "/") return null; // 根已是顶（win 为盘符列表页）
  const t = p.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i <= 0 ? "/" : t.slice(0, i); // win："C:/" 上一级也是 "/"（盘符列表）
};

// 面包屑段：POSIX home 子树首段折叠 ~；win 绝对路径（首段「电脑」→ 盘符 → 逐段）
const crumbsOf = (b: string, home: string): [string, string][] => {
  const out: [string, string][] = [];
  const win = isWinPath(b) || isWinPath(home);
  if (win) {
    out.push(["电脑", "/"]);
    if (!isWinPath(b)) return out; // 盘符列表页
    const drive = b.slice(0, 2); // "C:"
    out.push([drive, drive + "/"]);
    let acc = drive + "/";
    for (const seg of b.slice(3).split("/").filter(Boolean)) {
      acc += seg;
      out.push([seg, acc]);
      acc += "/";
    }
    return out;
  }
  if (home && (b === home || b.startsWith(home + "/"))) {
    out.push(["~", home]);
    let acc = home;
    for (const seg of b.slice(home.length).split("/").filter(Boolean)) {
      acc += "/" + seg;
      out.push([seg, acc]);
    }
    return out;
  }
  out.push(["/", "/"]);
  let acc = "";
  for (const seg of b.split("/").filter(Boolean)) {
    acc += "/" + seg;
    out.push([seg, acc]);
  }
  return out;
};

export default function DirPicker({ home, current, onPick, onClose }: {
  home: string;
  current: string;
  onPick: (p: string) => void;
  onClose: () => void;
}) {
  const [browse, setBrowse] = useState(current || home || "/");
  const [dirs, setDirs] = useState<string[] | null>(null); // null = 加载中
  const [drives, setDrives] = useState(false); // win 根级：dirs 是盘符列表（C:、D:…）
  const [err, setErr] = useState("");

  const load = useCallback(async (p: string) => {
    setDirs(null);
    setErr("");
    try {
      // /api/fs/dirs：只列子目录（win 根级返回盘符清单，跨盘换目录靠它）
      const r = await fetch(`${API}/fs/dirs?path=${encodeURIComponent(p)}`);
      const d = await r.json();
      if (!r.ok) { setErr(d.error || "读取失败"); setDirs([]); setDrives(false); return; }
      setDirs(Array.isArray(d.dirs) ? d.dirs : []);
      setDrives(d.drives === true);
    } catch {
      setErr("网络错误");
      setDirs([]);
      setDrives(false);
    }
  }, []);
  useEffect(() => { load(browse); }, [browse, load]);

  // Esc / 点外部关闭。role="dialog"：ChatPanel 的全局 Esc 处理器见此属性即放行
  // （否则 Esc 会先触发"打断会话"）；本组件自己的 keydown 再收浮层。
  useEffect(() => {
    const md = () => onClose();
    const kd = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", md);
    window.addEventListener("keydown", kd);
    return () => {
      window.removeEventListener("mousedown", md);
      window.removeEventListener("keydown", kd);
    };
  }, [onClose]);

  const crumbs = crumbsOf(browse, home);
  const up = parentOfDir(browse);

  return (
    // absolute 定位由调用方（ChatPanel 头部）负责；这里只出面板本体
    <div
      role="dialog"
      className="flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-md border border-border bg-popover text-xs shadow-xl"
      onMouseDown={(e) => e.stopPropagation()}>
      {/* 面包屑 + 上一级 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <button
          className={cn("shrink-0 rounded p-0.5 hover:bg-accent", !up && "pointer-events-none opacity-30")}
          title={up ? `上一级：${up}` : "已是根目录"}
          onClick={() => up && setBrowse(up)}>
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-[0.6875rem]">
          {crumbs.map(([label, path], i) => (
            <button
              key={path}
              className={cn("shrink-0 rounded px-1 py-0.5 hover:bg-accent",
                i === crumbs.length - 1 ? "text-foreground" : "text-muted-foreground")}
              title={path}
              onClick={() => setBrowse(path)}>
              {label}{i < crumbs.length - 1 && <span className="pl-0.5 opacity-40">/</span>}
            </button>
          ))}
        </div>
      </div>
      {/* 目录列表：单击进入；行尾 hover ✓ 直选 */}
      <div className="min-h-24 flex-1 overflow-y-auto p-1">
        {dirs === null ? (
          <div className="flex items-center justify-center gap-1.5 p-3 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />读取中…
          </div>
        ) : err ? (
          <p className="p-3 text-center text-destructive">{err}</p>
        ) : !dirs.length ? (
          <p className="p-3 text-center text-muted-foreground/70">此层没有子目录</p>
        ) : dirs.map((d) => {
          // 盘符列表页 dirs 项是 "C:" 形态 → full 特判拼 "C:/"；普通层拼 browse/d
          const full = drives ? d + "/" : browse.replace(/\/+$/, "") + "/" + d;
          return (
          <div key={d} className="group/row flex items-center">
            <button
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 py-1 text-left hover:bg-accent"
              title={`进入 ${full}`}
              onClick={() => setBrowse(full)}>
              {drives
                ? <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                : <Folder className="h-3.5 w-3.5 shrink-0 text-[oklch(0.75_0.14_85)]" />}
              <span className="truncate">{d}</span>
            </button>
            <button
              className="mr-1 hidden shrink-0 rounded p-0.5 text-primary hover:bg-accent group-hover/row:block"
              title={`选这个目录：${full}`}
              onClick={() => onPick(full)}>
              <Check className="h-3.5 w-3.5" />
            </button>
          </div>
          );
        })}
      </div>
      {/* 底部确认栏：醒目 ✓ 主操作（当前浏览层级即候选）。
          路径可能被截断——hover 气泡给完整绝对路径（是否当前目录一并注明）。
          盘符列表页（win「电脑」）不是可用的会话目录，禁选 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-background/60 px-2 py-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-muted-foreground"
          title={sameDir(browse, current) ? `${browse}（当前工作目录）` : `选定工作目录：${browse}`}>
          {sameDir(browse, current) ? browse + "（当前）" : browse}
        </span>
        <button
          className={cn("flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40")}
          disabled={drives}
          title={drives ? "请先进入某个盘符" : undefined}
          onClick={() => onPick(browse)}>
          <Check className="h-3.5 w-3.5" />选这个目录
        </button>
      </div>
    </div>
  );
}
