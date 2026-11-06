// keeperd 客户端:经 ccweb server 的 /api/keeper/* 反代(同源,无需 CORS)。
// token 存 localStorage;401 由调用方引导重新登录。
import { API } from "./api";

const TK = "ccweb.keeperd_token";
export const kdToken = () => { try { return localStorage.getItem(TK) || ""; } catch { return ""; } };
export const kdSetToken = (t: string) => { try { t ? localStorage.setItem(TK, t) : localStorage.removeItem(TK); } catch {} };

export interface EnvInfo { container: boolean; keeperd: boolean; keeperd_url: string }
export async function kdEnv(): Promise<EnvInfo> {
  const r = await fetch(`${API}/env`);
  return r.json();
}

export class KdErr extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

export async function kfetch(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<any> {
  const r = await fetch(`${API}/keeper${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(kdToken() ? { authorization: `Bearer ${kdToken()}` } : {}), ...(init?.headers || {}) },
  });
  const text = await r.text();
  let v: any = null; try { v = text ? JSON.parse(text) : null; } catch { v = text; }
  if (!r.ok) throw new KdErr(r.status, v?.error || `HTTP ${r.status}`);
  return v;
}

export async function kdLogin(username: string, password: string): Promise<string> {
  const v = await kfetch("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  if (!v?.token) throw new Error("登录响应缺 token");
  kdSetToken(v.token);
  return v.token;
}
