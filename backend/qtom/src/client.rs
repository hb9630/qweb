// OpenAI 兼容 chat/completions SSE 客户端。
// 面向 dsweb daemon（DeepSeek 网页版）：流式为"假流式"（稳态轮询 diff），
// chunk 节奏可能稀疏——不设总超时，靠调用方的空闲看门狗。
use futures_util::StreamExt;
use serde_json::{json, Value};

pub struct DsClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

/// 一次模型请求的收尾产物：文本全文 + 结构化工具调用 + finish_reason
pub struct ChatReply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: String,
}

#[derive(Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value, // 解析好的参数对象（daemon 侧为原子块；增量形态亦按 index 聚合）
}

/// SSE 流中吐给调用方的增量回调数据
pub enum StreamItem {
    Delta(String),     // 文本增量
    Done(ChatReply),   // 流结束（[DONE] 或 finish_reason 到达后的聚合）
    Error(String),     // 协议/传输错误（附上下文）
}

impl DsClient {
    pub fn new(base: &str, token: &str) -> Self {
        Self {
            http: reqwest::Client::builder().build().expect("reqwest client"),
            base: base.trim_end_matches('/').to_string(),
            token: token.to_string(),
        }
    }

    /// 发起流式请求并驱动到结束。on_delta 收文本增量（实时上屏用）。
    pub async fn chat(&self, messages: &[Value], tools: &[Value], on_delta: &mut dyn FnMut(&str)) -> Result<ChatReply, String> {
        let mut body = json!({ "model": "deepseek-web", "messages": messages, "stream": true });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.to_vec());
        }
        let resp = self
            .http
            .post(format!("{}/v1/chat/completions", self.base))
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(serde_json::to_string(&body).unwrap_or_default())
            .send()
            .await
            .map_err(|e| format!("dsweb 连接失败: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            let t = resp.text().await.unwrap_or_default();
            let t = t.chars().take(300).collect::<String>();
            return Err(format!("dsweb {status}: {t}"));
        }
        // 非 SSE 响应体：整体按 completion JSON 解析（一次性发全文）
        let ct = resp.headers().get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !ct.contains("event-stream") {
            let v: Value = serde_json::from_str(&resp.text().await.map_err(|e| e.to_string())?)
                .map_err(|e| format!("dsweb 非 JSON 响应: {e}"))?;
            let mut text = String::new();
            if let Some(t) = v.pointer("/choices/0/message/content").and_then(|x| x.as_str()) {
                text.push_str(t);
            }
            return Ok(ChatReply {
                tool_calls: vec![],
                finish_reason: "stop".into(),
                text,
            });
        }

        // SSE 累积状态
        let mut text = String::new();
        let mut calls: Vec<(usize, String, String, String)> = vec![]; // (index, id, name, arguments-json 字符串累积)
        let mut finish = String::new();
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        loop {
            let chunk = tokio::select! {
                c = stream.next() => match c {
                    Some(Ok(b)) => b,
                    Some(Err(e)) => return Err(format!("dsweb 流中断: {e}")),
                    None => break, // 服务端直接断流：按已收内容收尾
                },
                // chunk 空闲看门狗：网页版稳态轮询下正常间隔 ≤ 2.5s，120s 无数据视为挂死
                _ = tokio::time::sleep(std::time::Duration::from_secs(120)) => {
                    return Err("dsweb 流 120s 无数据（看门狗）".into());
                }
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            // 逐行处理：data: 行累积，空行派发
            while let Some(pos) = buf.find('\n') {
                let line: String = buf.drain(..=pos).collect();
                let line = line.trim_end_matches(['\n', '\r']);
                if line.is_empty() {
                    continue;
                }
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        return Ok(aggregate(text, calls, finish));
                    }
                    let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                    if let Some(err) = v.pointer("/error/message").and_then(|x| x.as_str()) {
                        return Err(format!("dsweb: {err}"));
                    }
                    if let Some(fr) = v.pointer("/choices/0/finish_reason").and_then(|x| x.as_str()) {
                        finish = fr.to_string();
                    }
                    if let Some(d) = v.pointer("/choices/0/delta/content").and_then(|x| x.as_str()) {
                        text.push_str(d);
                        on_delta(d);
                    }
                    // tool_calls 增量按 index 聚合（daemon 发原子块；真 OpenAI 发增量——都吃）
                    if let Some(Value::Array(tcs)) = v.pointer("/choices/0/delta/tool_calls") {
                        for tc in tcs {
                            let idx = tc.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                            while calls.len() <= idx {
                                calls.push((calls.len(), String::new(), String::new(), String::new()));
                            }
                            let slot = &mut calls[idx];
                            if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                                if !id.is_empty() { slot.1 = id.to_string(); }
                            }
                            if let Some(n) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                                if !n.is_empty() { slot.2 = n.to_string(); }
                            }
                            if let Some(a) = tc.pointer("/function/arguments").and_then(|x| x.as_str()) {
                                slot.3.push_str(a);
                            }
                        }
                    }
                }
            }
        }
        Ok(aggregate(text, calls, finish))
    }
}

fn aggregate(text: String, calls: Vec<(usize, String, String, String)>, finish: String) -> ChatReply {
    let mut tool_calls = vec![];
    for (_, id, name, args) in calls {
        if name.is_empty() { continue; }
        let arguments = serde_json::from_str::<Value>(&args).unwrap_or(Value::Null);
        tool_calls.push(ToolCall {
            id: if id.is_empty() { format!("call_{:08x}", tool_calls.len() as u64 + 1) } else { id },
            name,
            arguments,
        });
    }
    let finish_reason = if !tool_calls.is_empty() && finish != "tool_calls" {
        "tool_calls".to_string() // 有调用但 daemon 漏了 finish_reason：按调用处理
    } else {
        finish
    };
    ChatReply { text, tool_calls, finish_reason }
}

// ---------- SSE 聚合纯函数单测 ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn call(text: &str, calls: Vec<(usize, String, String, String)>, finish: &str) -> ChatReply {
        aggregate(text.into(), calls, finish.into())
    }

    #[test]
    fn aggregate_text_only() {
        let r = call("你好", vec![], "stop");
        assert_eq!(r.text, "你好");
        assert!(r.tool_calls.is_empty());
    }

    #[test]
    fn aggregate_atomic_tool_call() {
        let r = call(
            "我看看\n",
            vec![(0, "call_dsweb_1".into(), "bash".into(), r#"{"command":"ls"}"#.into())],
            "tool_calls",
        );
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0].name, "bash");
        assert_eq!(r.tool_calls[0].arguments["command"], "ls");
    }

    #[test]
    fn aggregate_incremental_args() {
        // 真 OpenAI 增量形态：arguments 分两段
        let r = call(
            "",
            vec![(0, "c1".into(), "edit".into(), r#"{"path":"a.rs","#.to_string() + r#""old_str":"x"}"#)],
            "tool_calls",
        );
        assert_eq!(r.tool_calls[0].arguments["path"], "a.rs");
    }

    #[test]
    fn aggregate_missing_finish() {
        // 有调用但 finish_reason 缺失 → 按 tool_calls 处理
        let r = call("", vec![(0, "c1".into(), "grep".into(), "{}".into())], "");
        assert_eq!(r.finish_reason, "tool_calls");
    }

    #[test]
    fn aggregate_synthesized_id() {
        let r = call("", vec![(0, String::new(), "glob".into(), "{}".into())], "tool_calls");
        assert!(r.tool_calls[0].id.starts_with("call_"));
    }
}
