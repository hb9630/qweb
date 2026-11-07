// /ws/{id} 会话管道 —— 对照 server.mjs:761-777
// 连接即回放：{t:"replay"} → buf 定稿事件 → 未完增量合成帧 → 实时流。
use crate::sessions::Session;
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc::unbounded_channel;

/// data URL（data:image/png;base64,xxx）→ (mime, base64)。坏条目跳过；
/// 单图超 8MB 丢弃（stdin 管道与 API 侧双重保险，前端另有 4MB 提示）
fn parse_images(v: Option<&Value>) -> Vec<(String, String)> {
    let mut out = vec![];
    let Some(Value::Array(list)) = v else { return out };
    for item in list {
        let Some(s) = item.as_str() else { continue };
        let Some(rest) = s.strip_prefix("data:") else { continue };
        let Some((meta, b64)) = rest.split_once(",") else { continue };
        let mime = meta.strip_suffix(";base64").unwrap_or("image/png").to_string();
        if !mime.starts_with("image/") || b64.is_empty() || b64.len() > 8 * 1024 * 1024 {
            continue;
        }
        out.push((mime, b64.to_string()));
    }
    out
}

pub async fn handle_session_ws(session: Arc<Session>, socket: WebSocket) {
    let (tx, mut rx) = unbounded_channel::<Message>();
    let (client_id, alive, buf, partial, exit_code) = session.subscribe(tx);
    let (mut sender, mut receiver) = socket.split();

    // ---- 回放（与 publish 临界区同锁快照：不重不漏）----
    let mut ok = sender
        .send(Message::Text(json!({ "t": "replay", "cwd": session.cwd, "alive": alive }).to_string().into()))
        .await
        .is_ok();
    for ev in &buf {
        if !ok {
            break;
        }
        ok = sender.send(Message::Text(json!({ "t": "cc", "ev": ev }).to_string().into())).await.is_ok();
    }
    if ok {
        if let Some(p) = partial {
            // 合成一条全量增量帧（客户端按追加处理），仅三字段
            let _ = sender
                .send(Message::Text(
                    json!({ "t": "cc", "ev": { "type": "stream_event", "event": { "delta": { "text": p } } } })
                        .to_string()
                        .into(),
                ))
                .await;
        }
    }

    // 进程已死（含 spawn 失败）后订阅的客户端：补发 exit 帧（Node 只发给当时在线者）
    if let Some(code) = exit_code {
        let _ = sender.send(Message::Text(json!({ "t": "exit", "code": code }).to_string().into())).await;
    }

    // ---- 泵：发布通道 → 下行；上行帧 → 分发 ----
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
                    // 坏 JSON 静默丢；!alive 时全忽略（server.mjs:768-774）
                    let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
                    if !session.alive() {
                        continue;
                    }
                    match v.get("t").and_then(|x| x.as_str()) {
                        Some("user") => {
                            if let Some(text) = v.get("text").and_then(|x| x.as_str()) {
                                session.send_user(text, &parse_images(v.get("images"))).await;
                            }
                        }
                        Some("perm") => {
                            // 审批决定：{"t":"perm","rid":...,"allow":bool}
                            let rid = v.get("rid").and_then(|x| x.as_str()).unwrap_or("");
                            if !rid.is_empty() {
                                let allow = v.get("allow").and_then(|x| x.as_bool()).unwrap_or(false);
                                session.perm_respond(rid, allow).await;
                            }
                        }
                        Some("interrupt") => session.interrupt().await,
                        Some("ctrl") => {
                            let sub = v.get("sub").and_then(|x| x.as_str()).unwrap_or("");
                            let args = v.get("args").cloned();
                            session.ctrl(sub, args).await;
                        }
                        _ => {}
                    }
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            },
        }
    }
    session.unsubscribe(client_id);
}
