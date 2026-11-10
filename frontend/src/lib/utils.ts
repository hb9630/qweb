import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 目录等价判断：同一目录在前端有两种形式——fs API/选择器产出正斜杠（C:/a/b），
// transcript cwd 是 CLI 落盘的反斜杠（C:\a\b）。历史浮层/recents 等按目录过滤的
// 比较一律走这里，严格 === 会让"选过目录后历史全空"（形式错位）。
// win 盘符路径（形态自判，兼容跨平台浏览器访问）：斜杠归一 + 大小写不敏感 + 去尾斜杠；
// POSIX 大小写敏感，只去尾斜杠。
export function sameDir(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string) =>
    /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      : p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// 显示层 OS 分隔符：fs API/选择器产出的路径统一正斜杠（键、sameDir 比较、API 调用
// 一律保持正斜杠不动），仅渲染时转本地形态——Windows 路径（盘符开头）显示 C:\a\b
// （资源管理器同款），POSIX 原样。判定按路径自身形态而非浏览器 UA：远程访问
// （Windows 浏览器连 Linux 服务器）时按 UA 会把 POSIX 路径错转成 \home\…。
// 面包屑段间分隔符用 pathSep(该段累积路径)。
export const isWinPath = (p: string) => /^[A-Za-z]:[\\/]/.test(p);
export const dispPath = (p: string) => (isWinPath(p) ? p.replace(/\//g, "\\") : p);
export const pathSep = (p?: string) => (p && isWinPath(p) ? "\\" : "/");
