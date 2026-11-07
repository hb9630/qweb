// /ws/fs 订阅中心 —— 对照 server.mjs:670-731,739-757
// 客户端 sub 目录集合（replace 语义）；被订阅目录建非递归 watch；
// 事件归并「该目录有变」，120ms 去抖，按各 ws 订阅交集推 {t:"fs",dirs:[...]}。
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

static WS_ID: AtomicU64 = AtomicU64::new(1);

struct Sub {
    tx: UnboundedSender<Message>,
    dirs: HashSet<String>,
}

#[derive(Default)]
struct HubInner {
    subs: HashMap<u64, Sub>,
    watches: HashMap<String, HashSet<u64>>, // dir → 订阅者 id 集（用户表述与 canonical 双键）
    aliases: HashMap<String, String>,       // canonical 路径 → 用户表述（macOS FSEvents 报真实路径，/tmp → /private/tmp）
    dirty: HashSet<String>,
    debounce: bool,
}

pub struct FsHub {
    inner: Mutex<HubInner>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    // notify 回调跑在自身线程（非 tokio runtime），去抖定时须经 Handle 派发
    handle: tokio::runtime::Handle,
}

impl FsHub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HubInner::default()),
            watcher: Mutex::new(None),
            handle: tokio::runtime::Handle::current(),
        })
    }

    /// WS 连接生命周期（server.mjs:740-756）
    pub async fn handle_ws(self: Arc<Self>, socket: WebSocket) {
        let id = WS_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = unbounded_channel::<Message>();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.subs.insert(id, Sub { tx, dirs: HashSet::new() });
        }
        let (mut sender, mut receiver) = socket.split();
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Some(msg) => {
                        if sender.send(msg).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                },
                m = receiver.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        // sub 帧：整组替换订阅（safePath 归一，空串过滤；坏 JSON 静默丢）
                        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else { continue };
                        if v.get("t").and_then(|x| x.as_str()) == Some("sub") {
                            if let Some(list) = v.get("dirs").and_then(|x| x.as_array()) {
                                let dirs: Vec<String> = list
                                    .iter()
                                    .filter_map(|d| d.as_str())
                                    .map(crate::util::safe_path)
                                    .filter(|d| !d.is_empty())
                                    .collect();
                                self.set_subs(id, dirs);
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                },
            }
        }
        self.cleanup(id);
    }

    fn set_subs(self: &Arc<Self>, id: u64, next: Vec<String>) {
        let mut add: Vec<String> = vec![];
        let mut remove: Vec<String> = vec![];
        {
            let mut inner = self.inner.lock().unwrap();
            let Some(sub) = inner.subs.get_mut(&id) else { return };
            let next: HashSet<String> = next.into_iter().collect();
            for d in &next {
                if !sub.dirs.contains(d) {
                    add.push(d.clone());
                }
            }
            for d in &sub.dirs {
                if !next.contains(d) {
                    remove.push(d.clone());
                }
            }
            sub.dirs = next;
            for d in &add {
                inner.watches.entry(d.clone()).or_default().insert(id);
                // canonical 别名同键注册（事件按真实路径到达时也能命中）
                if let Ok(c) = std::fs::canonicalize(d) {
                    let c = c.to_string_lossy().replace('\\', "/");
                    if c != *d {
                        inner.aliases.insert(c.clone(), d.clone());
                        inner.watches.entry(c).or_default().insert(id);
                    }
                }
            }
            for d in &remove {
                if let Some(set) = inner.watches.get_mut(d) {
                    set.remove(&id);
                }
                if let Ok(c) = std::fs::canonicalize(d) {
                    let c = c.to_string_lossy().replace('\\', "/");
                    if let Some(set) = inner.watches.get_mut(&c) {
                        set.remove(&id);
                    }
                }
            }
        }
        for d in add {
            self.watch_dir(&d); // 新目录才真正建 watch（失败静默，客户端退回手动刷新）
        }
        for d in remove {
            self.drop_watch_if_idle(&d);
        }
    }

    fn watch_dir(self: &Arc<Self>, dir: &str) {
        let mut w = self.watcher.lock().unwrap();
        if w.is_none() {
            let hub = self.clone();
            let cb = move |r: Result<Event, notify::Error>| hub.on_notify(r);
            *w = notify::recommended_watcher(cb).ok();
        }
        if let Some(w) = w.as_mut() {
            let _ = w.watch(Path::new(dir), RecursiveMode::NonRecursive); // 失败静默
        }
    }

    fn drop_watch_if_idle(self: &Arc<Self>, dir: &str) {
        let idle = {
            let inner = self.inner.lock().unwrap();
            inner.watches.get(dir).is_none_or(|s| s.is_empty())
        };
        if idle {
            let mut inner = self.inner.lock().unwrap();
            inner.watches.remove(dir);
            if let Ok(c) = std::fs::canonicalize(dir) {
                let c = c.to_string_lossy().replace('\\', "/");
                inner.watches.remove(&c);
            }
            drop(inner);
            if let Some(w) = self.watcher.lock().unwrap().as_mut() {
                let _ = w.unwatch(Path::new(dir));
            }
        }
    }

    fn cleanup(self: &Arc<Self>, id: u64) {
        let dirs: Vec<String> = {
            let mut inner = self.inner.lock().unwrap();
            match inner.subs.remove(&id) {
                Some(sub) => sub.dirs.into_iter().collect(),
                None => vec![],
            }
        };
        for d in dirs {
            self.drop_watch_if_idle(&d);
        }
    }

    /// notify 回调（其自身线程）：事件路径本身或其父目录是被 watch 目录 → 标脏
    fn on_notify(self: &Arc<Self>, r: Result<Event, notify::Error>) {
        match r {
            Ok(ev) => {
                for p in ev.paths {
                    let ps = p.to_string_lossy().replace('\\', "/");
                    // fs.watch(dir) 对「目录内增删改」回调：脏目录 = 事件路径的父目录；
                    // 事件落在被 watch 目录自身（重命名等）也算它脏
                    if let Some(i) = ps.rfind('/') {
                        self.mark_dirty(&ps[..i]);
                    }
                    self.mark_dirty(&ps);
                }
            }
            Err(e) => {
                // watch 失效（目录被删/移走）：通知订阅者刷新后清理（server.mjs:714-719）
                let mut notify_dirs = vec![];
                if let Some(p) = e.paths.first() {
                    let ps = p.to_string_lossy().replace('\\', "/");
                    let cand = [ps.clone(), ps.rfind('/').map(|i| ps[..i].to_string()).unwrap_or_default()];
                    let mut inner = self.inner.lock().unwrap();
                    for c in cand {
                        if let Some(ids) = inner.watches.remove(&c) {
                            for id in &ids {
                                if let Some(sub) = inner.subs.get(id) {
                                    let _ = sub.tx.send(Message::Text(json!({ "t": "fs", "dirs": [c] }).to_string().into()));
                                }
                                if let Some(sub) = inner.subs.get_mut(id) {
                                    sub.dirs.remove(&c);
                                }
                            }
                            notify_dirs.push(c);
                        }
                    }
                }
                for d in notify_dirs {
                    if let Some(w) = self.watcher.lock().unwrap().as_mut() {
                        let _ = w.unwatch(Path::new(&d));
                    }
                }
            }
        }
    }

    fn mark_dirty(self: &Arc<Self>, dir: &str) {
        let spawn_flush = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.watches.contains_key(dir) {
                return;
            }
            // canonical 键（FSEvents 真实路径）→ 用户表述（订阅/推送两侧一致）
            let key = inner.aliases.get(dir).cloned().unwrap_or_else(|| dir.to_string());
            inner.dirty.insert(key);
            if inner.debounce {
                false
            } else {
                inner.debounce = true;
                true
            }
        };
        if spawn_flush {
            let hub = self.clone();
            self.handle.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                hub.flush();
            });
        }
    }

    /// 120ms 到点：取走脏集合，按各 ws 订阅交集推送（server.mjs:684-693）
    fn flush(self: &Arc<Self>) {
        let dirty: Vec<String> = {
            let mut inner = self.inner.lock().unwrap();
            inner.debounce = false;
            std::mem::take(&mut inner.dirty).into_iter().collect()
        };
        let inner = self.inner.lock().unwrap();
        for sub in inner.subs.values() {
            let hit: Vec<&String> = dirty.iter().filter(|d| sub.dirs.contains(*d)).collect();
            if !hit.is_empty() {
                let dirs: Vec<String> = hit.into_iter().cloned().collect();
                let _ = sub.tx.send(Message::Text(json!({ "t": "fs", "dirs": dirs }).to_string().into()));
            }
        }
    }
}
