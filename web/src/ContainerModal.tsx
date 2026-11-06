// 在目录上创建容器:表单(主机/镜像/资源/端口)→ keeperd POST /api/containers,
// 目录 -v 挂 /workspace。「样板房」类确定性操作,不走 AI;业务修改回对话做。
import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { KdErr, kdLogin, kfetch } from "./lib/keeperd";

interface Img { id: number; name: string; ref: string; apps: { name: string; port: number }[] }
interface Host { id: number; name: string; addr: string; online: boolean }

export default function ContainerModal({ dir, onClose }: { dir: string; onClose: () => void }) {
  const [needLogin, setNeedLogin] = useState(false);
  const [user, setUser] = useState(""); const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [hosts, setHosts] = useState<Host[]>([]);
  const [images, setImages] = useState<Img[]>([]);
  const [hostId, setHostId] = useState(0);
  const [imageId, setImageId] = useState(0);
  const [name, setName] = useState("");
  const [cpu, setCpu] = useState("2");
  const [mem, setMem] = useState("2048");
  const [done, setDone] = useState<{ host: string; ports: Record<string, string>; addr: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [hs, imgs] = await Promise.all([
          kfetch("/api/hosts"),
          kfetch("/api/images"),
        ]);
        const online = (hs as Host[]).filter((h) => h.online);
        setHosts(online);
        setHostId(online[0]?.id ?? 0);
        const en = (imgs as Img[]).filter((i) => i.ref);
        setImages(en);
        setImageId(en[0]?.id ?? 0);
      } catch (e) {
        if (e instanceof KdErr && e.status === 401) setNeedLogin(true);
        else setErr(String((e as Error).message));
      }
    })();
  }, []);

  const login = async () => {
    setBusy(true); setErr("");
    try { await kdLogin(user, pass); setNeedLogin(false); }
    catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  const create = async () => {
    setBusy(true); setErr("");
    try {
      // 端口 = 镜像 apps 声明(22 由后端自动加);目录挂 /workspace
      const img = images.find((i) => i.id === imageId);
      const ports = [...new Set((img?.apps || []).map((a) => a.port).filter((p) => p > 0))];
      const v = await kfetch("/api/containers", {
        method: "POST",
        body: JSON.stringify({
          name, host_id: hostId, image_id: imageId,
          cpu_cores: Number(cpu) || 2, mem_mb: Number(mem) || 2048,
          container_ports: ports, dir,
          mounts: [{ host: dir, container: "/workspace" }],
        }),
        timeoutMs: 600_000,
      });
      // 创建成功后查一次列表拿端口映射(直出入口)
      const list = await kfetch("/api/containers");
      const c = list.containers?.find((x: any) => x.cid === v.id);
      const host = hosts.find((h) => h.id === hostId);
      setDone({ host: host?.name || "", addr: host?.addr || "", ports: c?.ports || {} });
    } catch (e) { setErr(String((e as Error).message)); }
    setBusy(false);
  };

  const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/60";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" onMouseDown={onClose}>
      <div className="w-[26rem] rounded-lg border border-border bg-popover p-4 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold">在此目录创建容器</div>
          <button className="rounded p-0.5 hover:bg-accent" onClick={onClose}><X className="h-3.5 w-3.5" /></button>
        </div>
        <div className="mb-3 truncate rounded bg-background/70 px-2 py-1.5 text-[0.6875rem] text-muted-foreground" title={dir}>
          {dir} → /workspace
        </div>

        {done ? (
          <div className="space-y-2 text-xs">
            <div className="text-emerald-500">✔ 容器已创建(主机 {done.host})</div>
            <div className="rounded border border-border bg-background/60 p-2 font-mono text-[0.6875rem] leading-5">
              {Object.entries(done.ports).map(([cp, hp]) => (
                <div key={cp}>端口 {cp} → {done.addr}:{hp}</div>
              ))}
            </div>
            <div className="text-muted-foreground">目录已挂载到容器 /workspace;SSH 与 Web 端口直出如上。</div>
            <button className="w-full rounded-md bg-primary px-3 py-1.5 text-primary-foreground" onClick={onClose}>完成</button>
          </div>
        ) : needLogin ? (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">登录 keeperd(容器编排服务)</div>
            <input className={field} placeholder="用户名" value={user} onChange={(e) => setUser(e.target.value)} />
            <input className={field} type="password" placeholder="密码" value={pass} onChange={(e) => setPass(e.target.value)} />
            {err && <div className="text-[0.6875rem] text-red-500">{err}</div>}
            <button className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
              disabled={busy || !user || !pass} onClick={login}>
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}登录
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-xs">
            <div className="flex gap-2">
              <label className="w-1/2 space-y-1">
                <div className="text-muted-foreground">主机</div>
                <select className={field} value={hostId} onChange={(e) => setHostId(Number(e.target.value))}>
                  {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}({h.addr})</option>)}
                </select>
              </label>
              <label className="w-1/2 space-y-1">
                <div className="text-muted-foreground">镜像</div>
                <select className={field} value={imageId} onChange={(e) => setImageId(Number(e.target.value))}>
                  {images.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>
              </label>
            </div>
            <label className="block space-y-1">
              <div className="text-muted-foreground">容器名(小写字母数字,3-32 位)</div>
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-service" />
            </label>
            <div className="flex gap-2">
              <label className="w-1/2 space-y-1">
                <div className="text-muted-foreground">CPU 核数</div>
                <input className={field} value={cpu} onChange={(e) => setCpu(e.target.value)} />
              </label>
              <label className="w-1/2 space-y-1">
                <div className="text-muted-foreground">内存 MB</div>
                <input className={field} value={mem} onChange={(e) => setMem(e.target.value)} />
              </label>
            </div>
            {err && <div className="text-[0.6875rem] text-red-500">{err}</div>}
            <button className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50"
              disabled={busy || !name || !hostId || !imageId} onClick={create}>
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}创建(镜像首次分发可能需数分钟)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
