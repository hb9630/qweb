// 会话生命周期 —— 对照 server.mjs:128-250
// 每个 tab = 一个长驻 claude 进程（stream-json 双向管道）；关 tab 才 kill；
// 刷新经 ring buffer 回放恢复。spawn 失败 → 广播 exit（Node 挂死 bug 的修复点）。
use crate::config::Config;
use crate::ctxwin::CtxWin;
use crate::util::now_ms;
use axum::extract::ws::Message;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::RwLock;

static CLIENT_ID: AtomicU64 = AtomicU64::new(1);

pub type SessionMap = RwLock<HashMap<String, Arc<Session>>>;

struct Inner {
    alive: bool,
    pid: Option<u32>,
    claude_sid: Option<String>,
    buf: Vec<Value>,          // 回放缓冲：已定稿事件（不含 stream_event 增量）
    partial: Option<String>,  // 当前流式中的增量累积（重连时补发）
    last_active: u64,
    clients: HashMap<u64, UnboundedSender<Message>>,
    exit_code: Option<Option<i32>>, // Some(code) = 已退出（进程死后订阅的客户端补发 exit 帧）
    // 挂起的权限询问：can_use_tool control_request 的 request_id → request.input。
    // 回 allow 时要带 updatedInput（SDK 同款语义：原 input 原样返回，2.1.212 实测）
    pending_perms: HashMap<String, Value>,
}

pub struct Session {
    pub id: String,
    pub cwd: String,
    pub started_at: u64,
    inner: Mutex<Inner>,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    ctxwin: Arc<CtxWin>,
}

impl Session {
    pub async fn spawn_new(id: &str, cwd: &str, resume_sid: Option<&str>, cfg: &Config, ctxwin: Arc<CtxWin>) -> Arc<Self> {
        let s = Arc::new(Self {
            id: id.to_string(),
            cwd: cwd.to_string(),
            started_at: now_ms(),
            inner: Mutex::new(Inner {
                alive: true,
                pid: None,
                // resume 的官方会话 ID 即入参（init 要到首条消息才发，先标上，/api/sessions 才能定位 transcript）
                claude_sid: resume_sid.map(str::to_string),
                buf: vec![],
                partial: None,
                last_active: now_ms(),
                clients: HashMap::new(),
                exit_code: None,
                pending_perms: HashMap::new(),
            }),
            stdin: tokio::sync::Mutex::new(None),
            ctxwin,
        });
        s.spawn(cfg).await;
        s
    }

    async fn spawn(self: &Arc<Self>, cfg: &Config) {
        let (bin, pre) = cfg.claude_cmd();
        let mut args: Vec<String> = pre;
        args.extend([
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--include-partial-messages".into(),
            "--verbose".into(),
            // 权限询问走 control_request（can_use_tool）而非 headless 静默拒绝；
            // "stdio" 为带内通道值（SDK canUseTool 同款，CLI ≥2.1 实测）
            "--permission-prompt-tool".into(),
            "stdio".into(),
        ]);
        {
            let sid = self.inner.lock().unwrap().claude_sid.clone();
            if let Some(sid) = sid {
                args.push("--resume".into());
                args.push(sid);
            }
        }
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.args(&args)
            .current_dir(&self.cwd)
            .envs(cfg.child_env())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0); // 整组信号清理
        cmd.kill_on_drop(true);

        match cmd.spawn() {
            Err(_) => {
                // spawn 失败（二进制缺失/坏 cwd）：Node 挂死不回，此处立即广播 exit（偏差清单）
                self.mark_exit(None);
                return;
            }
            Ok(mut child) => {
                let pid = child.id();
                self.inner.lock().unwrap().pid = pid;
                let stdin = child.stdin.take().unwrap();
                *self.stdin.lock().await = Some(stdin);
                // stdout：字节级分行 + 有损 UTF-8（Node setEncoding("utf8") 续接语义）
                let s2 = self.clone();
                if let Some(mut out) = child.stdout.take() {
                    tokio::spawn(async move {
                        let mut carry: Vec<u8> = vec![];
                        let mut chunk = [0u8; 65536];
                        loop {
                            match out.read(&mut chunk).await {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    carry.extend_from_slice(&chunk[..n]);
                                    while let Some(pos) = carry.iter().position(|&b| b == b'\n') {
                                        let line: Vec<u8> = carry.drain(..=pos).collect();
                                        let line = String::from_utf8_lossy(&line).trim().to_string();
                                        if line.is_empty() {
                                            continue;
                                        }
                                        if let Ok(ev) = serde_json::from_str::<Value>(&line) {
                                            s2.on_event(ev);
                                        }
                                    }
                                }
                            }
                        }
                    });
                }
                // stderr：原样转发（不回放、不缓冲）
                let s3 = self.clone();
                if let Some(mut err) = child.stderr.take() {
                    tokio::spawn(async move {
                        let mut chunk = [0u8; 8192];
                        loop {
                            match err.read(&mut chunk).await {
                                Ok(0) | Err(_) => break,
                                Ok(n) => {
                                    let s = String::from_utf8_lossy(&chunk[..n]).into_owned();
                                    s3.publish(json!({ "t": "stderr", "s": s }));
                                }
                            }
                        }
                    });
                }
                // 退出：alive=false + exit 广播（信号退出 code()=None → JSON null，与 Node 对齐）
                let s4 = self.clone();
                tokio::spawn(async move {
                    let code = child.wait().await.ok().and_then(|st| st.code());
                    s4.mark_exit(code);
                });
            }
        }
    }

    fn mark_exit(self: &Arc<Self>, code: Option<i32>) {
        let mut inner = self.inner.lock().unwrap();
        inner.alive = false;
        inner.exit_code = Some(code);
        let msg = json!({ "t": "exit", "code": code });
        drop(inner);
        self.publish(msg);
    }

    /// 事件分发 —— 对照 onEvent（server.mjs:181-200）
    fn on_event(self: &Arc<Self>, ev: Value) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.last_active = now_ms();
            if ev.get("type").and_then(|v| v.as_str()) == Some("system")
                && ev.get("subtype").and_then(|v| v.as_str()) == Some("init")
            {
                if let Some(sid) = ev.get("session_id").and_then(|v| v.as_str()) {
                    inner.claude_sid = Some(sid.to_string()); // 官方会话 ID（transcript 文件名，resume 用）
                }
            }
            // 权限询问挂起登记（回 allow 要带原 input 作 updatedInput）；事件本体照常入 buf 回放
            if ev.get("type").and_then(|v| v.as_str()) == Some("control_request")
                && ev.pointer("/request/subtype").and_then(|v| v.as_str()) == Some("can_use_tool")
            {
                if let (Some(rid), Some(input)) = (
                    ev.get("request_id").and_then(|v| v.as_str()),
                    ev.pointer("/request/input").cloned(),
                ) {
                    inner.pending_perms.insert(rid.to_string(), input);
                }
            }
            if ev.get("type").and_then(|v| v.as_str()) == Some("stream_event") {
                // 增量不进 buf，只推流；记录累积以支持重连续播
                let d = ev
                    .pointer("/event/delta/text")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let p = inner.partial.get_or_insert_with(String::new);
                p.push_str(d);
                let msg = json!({ "t": "cc", "ev": ev });
                drop(inner);
                self.publish(msg);
                return;
            }
            // 定稿事件（system/assistant/user/result/control_response…）入 buf
            inner.buf.push(ev.clone());
            if ev.get("type").and_then(|v| v.as_str()) == Some("result") {
                inner.partial = None; // 一轮结束
                let mu = ev.get("modelUsage").cloned();
                drop(inner);
                self.ctxwin.remember(mu.as_ref()); // 分母记忆落盘
                self.publish(json!({ "t": "cc", "ev": ev }));
                return;
            }
        }
        self.publish(json!({ "t": "cc", "ev": ev }));
    }

    /// 序列化一次，发往全部客户端；发送失败（已断）即摘除
    fn publish(self: &Arc<Self>, msg: Value) {
        let s = msg.to_string();
        let mut inner = self.inner.lock().unwrap();
        inner.clients.retain(|_, tx| tx.send(Message::Text(s.clone().into())).is_ok());
    }

    /// 订阅 + 回放快照（与 publish 同一把锁，保证「快照前只在 buf、快照后只在 channel」）。
    /// 返回 (客户端 id, alive, buf, partial)；断开时按 id 摘除。
    pub fn subscribe(
        self: &Arc<Self>,
        tx: UnboundedSender<Message>,
    ) -> (u64, bool, Vec<Value>, Option<String>, Option<Option<i32>>) {
        let id = CLIENT_ID.fetch_add(1, Ordering::Relaxed);
        let mut inner = self.inner.lock().unwrap();
        inner.clients.insert(id, tx);
        (id, inner.alive, inner.buf.clone(), inner.partial.clone(), inner.exit_code)
    }

    pub fn unsubscribe(self: &Arc<Self>, id: u64) {
        self.inner.lock().unwrap().clients.remove(&id);
    }

    pub fn clients_empty(&self) -> bool {
        self.inner.lock().unwrap().clients.is_empty()
    }

    pub fn last_active(&self) -> u64 {
        self.inner.lock().unwrap().last_active
    }

    pub fn alive(&self) -> bool {
        self.inner.lock().unwrap().alive
    }

    pub fn claude_sid(&self) -> Option<String> {
        self.inner.lock().unwrap().claude_sid.clone()
    }

    pub fn snapshot(&self) -> serde_json::Value {
        let inner = self.inner.lock().unwrap();
        json!({
            "id": self.id,
            "cwd": self.cwd,
            "startedAt": self.started_at,
            "alive": inner.alive,
            "pid": inner.pid,
            "claude_sid": inner.claude_sid,
            "n": inner.buf.len(),
        })
    }

    /// stdin 写入（官方 SDK 格式；持久化由 claude transcript 完成）。
    /// 图片走 source.base64 块（data+media_type / mimeType 形态 2.1.212 实测均拒收）
    pub async fn send_user(self: &Arc<Self>, text: &str, images: &[(String, String)]) {
        let mut content = vec![json!({ "type": "text", "text": text })];
        for (mime, b64) in images {
            content.push(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": mime, "data": b64 }
            }));
        }
        let msg = json!({
            "type": "user", "session_id": "",
            "message": { "role": "user", "content": content },
        });
        self.write_stdin(&msg).await;
    }

    /// 审批回包。wire 格式（CLI 2.1.212 逐字实测）：request_id 嵌在 response 内；
    /// allow 回带 updatedInput=原 input（SDK 同款），deny 的 message 原样进 tool_result
    pub async fn perm_respond(self: &Arc<Self>, request_id: &str, allow: bool) {
        let input = self.inner.lock().unwrap().pending_perms.remove(request_id);
        let decision = match (allow, input) {
            (true, Some(input)) => json!({ "behavior": "allow", "updatedInput": input }),
            (true, None) => json!({ "behavior": "allow" }), // 未知/重复回包：尽力而为，CLI 侧自会去重
            (false, _) => json!({ "behavior": "deny", "message": "User denied via ccweb" }),
        };
        let msg = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": request_id, "response": decision },
        });
        self.write_stdin(&msg).await;
    }

    pub async fn interrupt(self: &Arc<Self>) {
        let msg = json!({
            "type": "control_request", "request_id": uuid_str(),
            "request": { "subtype": "interrupt" },
        });
        self.write_stdin(&msg).await;
    }

    /// control_request 通用通道：interrupt / set_permission_mode / set_model / …
    pub async fn ctrl(self: &Arc<Self>, subtype: &str, args: Option<Value>) {
        let mut request = json!({ "subtype": subtype });
        if let Some(Value::Object(map)) = args {
            if let Value::Object(r) = &mut request {
                for (k, v) in map {
                    r.insert(k, v);
                }
            }
        }
        let msg = json!({
            "type": "control_request", "request_id": uuid_str(),
            "request": request,
        });
        self.write_stdin(&msg).await;
    }

    async fn write_stdin(self: &Arc<Self>, msg: &Value) {
        let mut g = self.stdin.lock().await;
        if let Some(stdin) = g.as_mut() {
            let _ = stdin.write_all(format!("{msg}\n").as_bytes()).await;
        }
    }

    /// kill：SIGTERM → 3s → SIGKILL（server.mjs:226-231）
    pub fn kill(self: &Arc<Self>) {
        let pid = {
            let inner = self.inner.lock().unwrap();
            if !inner.alive {
                return;
            }
            inner.pid
        };
        let Some(pid) = pid else { return };
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
        }
        #[cfg(not(unix))]
        {
            // Windows：tokio 无信号粒度，直接强杀
        }
        let s = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if s.alive() {
                if let Some(pid) = s.inner.lock().unwrap().pid {
                    #[cfg(unix)]
                    unsafe {
                        libc::kill(pid as i32, libc::SIGKILL);
                    }
                }
            }
        });
    }
}

pub fn uuid_str() -> String {
    uuid::Uuid::new_v4().to_string()
}
