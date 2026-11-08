// CC stream-json 同构事件发射层：一行一 JSON 到 stdout（ccweb 按 \n 切行消费），
// 定稿事件同步落 transcript（CC JSONL 形状，history.rs 可读）。
// -p 模式下 stdout 静默（quiet），事件仅进 transcript，由 main 打印人类可读摘要。
use crate::transcript::Transcript;
use serde_json::{json, Value};
use std::io::Write;

pub const MODEL: &str = "deepseek-web";
pub const CTX_WIN: u64 = 65536; // 网页版上下文估计值（result.modelUsage 分母，前端 ctx% 用）

pub struct Emitter {
    pub quiet: bool,       // -p 模式：不写 stdout
    pub sid: String,
    pub cwd: String,
    tr: Transcript,
}

impl Emitter {
    pub fn new(quiet: bool, sid: &str, cwd: &str, tr: Transcript) -> Self {
        Self { quiet, sid: sid.into(), cwd: cwd.into(), tr }
    }

    /// 事件出站（stdout + 可选 transcript 双写）
    fn out(&mut self, ev: Value, to_tr: bool) {
        if !self.quiet {
            let mut so = std::io::stdout().lock();
            let _ = writeln!(so, "{ev}");
            let _ = so.flush(); // 管道读端实时性
        }
        if to_tr {
            self.tr.append(&ev);
        }
    }

    /// transcript 行包装：补 engine/cwd/session_id/timestamp（history 列表与 resume 依赖）
    fn wrap(&self, mut ev: Value) -> Value {
        if let Value::Object(m) = &mut ev {
            m.insert("engine".into(), "qtom".into());
            m.insert("cwd".into(), json!(self.cwd));
            m.insert("session_id".into(), json!(self.sid));
            m.insert("timestamp".into(), json!(now_iso()));
        }
        ev
    }

    pub fn init(&mut self, tools: &[Value]) {
        self.out(
            json!({
                "type": "system", "subtype": "init",
                "session_id": self.sid, "cwd": self.cwd,
                "model": MODEL, "permissionMode": "default",
                "slash_commands": ["clear"],
                "tools": tools.iter().filter_map(|t| t.pointer("/function/name").and_then(|n| n.as_str())).collect::<Vec<_>>(),
                "mcp_servers": [],
            }),
            false,
        );
    }

    pub fn conversation_reset(&mut self) {
        self.out(json!({ "type": "conversation_reset", "trigger": "clear" }), false);
    }

    pub fn user_echo(&mut self, text: &str) {
        self.out(
            self.wrap(json!({
                "type": "user",
                "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
            })),
            true,
        );
    }

    /// 一条插话式 user 行（中断标记等；`[` 开头不入 title）
    pub fn user_note(&mut self, text: &str) {
        self.user_echo(text);
    }

    pub fn message_start(&mut self) {
        self.out(
            json!({
                "type": "stream_event",
                "event": { "type": "message_start",
                    "message": { "id": uuid(), "type": "message", "role": "assistant", "model": MODEL } },
            }),
            false,
        );
    }

    pub fn text_start(&mut self, index: usize) {
        self.out(
            json!({ "type": "stream_event",
                "event": { "type": "content_block_start", "index": index, "content_block": { "type": "text", "text": "" } } }),
            false,
        );
    }

    pub fn text_delta(&mut self, index: usize, text: &str) {
        self.out(
            json!({ "type": "stream_event",
                "event": { "type": "content_block_delta", "index": index,
                    "delta": { "type": "text_delta", "text": text } } }),
            false,
        );
    }

    pub fn tool_use_start(&mut self, index: usize, id: &str, name: &str) {
        self.out(
            json!({ "type": "stream_event",
                "event": { "type": "content_block_start", "index": index,
                    "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} } } }),
            false,
        );
    }

    pub fn tool_input_delta(&mut self, index: usize, partial_json: &str) {
        self.out(
            json!({ "type": "stream_event",
                "event": { "type": "content_block_delta", "index": index,
                    "delta": { "type": "input_json_delta", "partial_json": partial_json } } }),
            false,
        );
    }

    /// assistant 定稿：content 数组（text? + tool_use…）。定稿文本必须与 delta 累积同源。
    pub fn assistant_final(&mut self, content: Vec<Value>, stop_reason: &str, usage: &Value) {
        let content = if content.is_empty() { vec![json!({"type":"text","text":""})] } else { content };
        self.out(
            self.wrap(json!({
                "type": "assistant",
                "message": { "id": uuid(), "type": "message", "role": "assistant", "model": MODEL,
                    "content": content, "stop_reason": stop_reason, "usage": usage },
            })),
            true,
        );
    }

    /// tool_result 定稿（user 事件承载）——关前端工具卡/审批卡
    pub fn tool_result(&mut self, tool_use_id: &str, content: &str, is_error: bool) {
        self.out(
            self.wrap(json!({
                "type": "user",
                "message": { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": tool_use_id, "content": content, "is_error": is_error } ] },
            })),
            true,
        );
    }

    /// bash 审批询问；前端审批卡 → ccweb control_response → stdin
    pub fn ask_perm(&mut self, request_id: &str, tool_use_id: &str, tool_name: &str, input: &Value) {
        self.out(
            json!({ "type": "control_request", "request_id": request_id,
                "request": { "subtype": "can_use_tool", "tool_use_id": tool_use_id,
                    "tool_name": tool_name, "input": input } }),
            false,
        );
    }

    pub fn result(&mut self, subtype: &str, is_error: bool, usage: &Value, num_turns: u64, extra_msg: Option<&str>) {
        let mut ev = json!({
            "type": "result", "subtype": subtype, "is_error": is_error,
            "usage": usage, "model": MODEL,
            "modelUsage": { MODEL: { "contextWindow": CTX_WIN } },
            "num_turns": num_turns, "session_id": self.sid,
        });
        if let Some(m) = extra_msg {
            ev["result"] = json!(m);
        }
        self.out(self.wrap(ev), true);
    }

    /// -p 模式人类可读摘要（stderr，不污染 stdout 协议/结果）
    pub fn note(&mut self, s: &str) {
        if self.quiet {
            eprintln!("[qtom] {s}");
        }
    }
}

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_iso() -> String {
    // 无 chrono：手工拼 ISO-8601 UTC（transcript timestamp 仅展示/排序用）
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", tod / 3600, (tod / 60) % 60, tod % 60, ms % 1000)
}

/// 天数→公历（Howard Hinnant 算法，1970 纪元）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_shape() {
        let s = now_iso();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z'));
        assert_eq!(&s[4..5], "-");
    }

    #[test]
    fn civil_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // 2024-01-01
    }
}
