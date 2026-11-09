// agent 核心：stdin 消息驱动轮次循环。
// 输入 AgentMsg（qweb 经 stdin 写 CC 格式，main 解析后转投信道）；
// 输出经 Emitter（CC 事件 stdout + transcript 双写）。
// 中断：专用信道（turn 开始前 drain 陈旧中断；turn 内所有 await 点 select 捕获）。
use crate::client::{ChatReply, DsClient};
use crate::proto::Emitter;
use crate::tools::{self, SYSTEM_PROMPT};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

pub enum AgentMsg {
    User { text: String },      // qweb {"type":"user","message":{content:[text]}}（图片块忽略）
    Perm { rid: String, allow: bool }, // qweb control_response（审批回包）
}

pub struct Agent {
    pub em: Emitter,
    cli: DsClient,
    cwd: String,
    home: String,
    messages: Vec<Value>,   // OpenAI 形态；[0]=system
    tool_seq: u64,          // toolu_{seq:08x} 单调
    rx: UnboundedReceiver<AgentMsg>,
    inter: UnboundedReceiver<()>, // 中断（幂等；turn 前 drain）
    tools: Vec<Value>,
    auto_yes: bool,         // -p 模式：bash 自动批准（--yes）
    queued: std::collections::VecDeque<String>, // 轮中到达的用户消息（result 后开新轮）
}

pub fn spawn_channel() -> (UnboundedSender<AgentMsg>, UnboundedReceiver<AgentMsg>) {
    tokio::sync::mpsc::unbounded_channel()
}

pub fn interrupt_channel() -> (UnboundedSender<()>, UnboundedReceiver<()>) {
    tokio::sync::mpsc::unbounded_channel()
}

impl Agent {
    pub fn new(
        em: Emitter,
        cli: DsClient,
        cwd: &str,
        home: &str,
        mut messages: Vec<Value>,
        tool_seq: u64,
        rx: UnboundedReceiver<AgentMsg>,
        inter: UnboundedReceiver<()>,
        auto_yes: bool,
    ) -> Self {
        // system 恒为首条（resume 再水化不含 system——rehydrate 只回 user/assistant/tool）；
        // {cwd} 注入实际会话目录（pi 同款 <cwd> 段）
        if messages.first().and_then(|m| m.get("role")).and_then(|r| r.as_str()) != Some("system") {
            messages.insert(0, json!({"role":"system","content":SYSTEM_PROMPT.replace("{cwd}", cwd)}));
        }
        Self {
            em,
            cli,
            cwd: cwd.into(),
            home: home.into(),
            messages,
            tool_seq,
            rx,
            inter,
            tools: tools::tools_json(),
            auto_yes,
            queued: std::collections::VecDeque::new(),
        }
    }

    /// 主循环：stdiio 长驻模式。返回即进程退出（stdin 关闭）。
    pub async fn run(&mut self) {
        self.em.init(&self.tools);
        while let Some(msg) = self.rx.recv().await {
            match msg {
                AgentMsg::User { text } => {
                    if text.trim() == "/clear" {
                        self.clear();
                        continue;
                    }
                    self.turn(text).await;
                    // result 已发：排队的用户消息依次开新轮
                    while let Some(q) = self.queued.pop_front() {
                        if q.trim() == "/clear" {
                            self.clear();
                            continue;
                        }
                        self.turn(q).await;
                    }
                }
                AgentMsg::Perm { .. } => {} // 空闲期审批回包（迟到/孤儿）：忽略
            }
        }
        // stdin 关闭：qweb 关 stdin = 优雅关闭（RPC 语义），直接退
    }

    fn clear(&mut self) {
        self.messages.truncate(1); // 只留 system
        self.queued.clear();
        while self.inter.try_recv().is_ok() {} // 清陈旧中断
        self.em.conversation_reset();
        self.em.note("会话已清空");
    }

    fn drain_interrupt(&mut self) {
        while self.inter.try_recv().is_ok() {}
    }

    /// 一轮（可含多次模型请求 + 工具执行），以 result 收尾
    async fn turn(&mut self, user_text: String) {
        self.drain_interrupt();
        let t0 = std::time::Instant::now();
        self.em.user_echo(&user_text);
        self.messages.push(json!({"role":"user","content":user_text}));
        let mut n_turns: u64 = 0;
        let mut last_usage = usage_zero();
        loop {
            n_turns += 1;
            // ---- 模型请求（流式）----
            self.em.message_start();
            let mut text_out = String::new();
            let reply: Result<ChatReply, String> = {
                // delta 回调要过 Emitter 借用——拆两段：先收全文与 delta 计数，事件后补不合适；
                // 这里直接在闭包里发 delta（Emitter 是 &mut self.em，chat 持有其它字段借用不冲突）
                let Agent { cli, messages, tools, em, inter, .. } = self;
                let mut first = true;
                let mut on_delta = |d: &str| {
                    if first {
                        em.text_start(0);
                        first = false;
                    }
                    em.text_delta(0, d);
                    text_out.push_str(d);
                };
                let r = tokio::select! {
                    r = cli.chat(messages, tools, &mut on_delta) => r,
                    _ = inter.recv() => Err("__interrupt__".into()),
                };
                r
            };
            let reply = match reply {
                Ok(r) => r,
                Err(e) if e == "__interrupt__" => {
                    self.handle_interrupt(&text_out, &mut last_usage, n_turns, t0);
                    return;
                }
                Err(e) => {
                    // 传输/协议错误：错误 result 收尾，messages 不回滚（user 已入栈，用户可重试）
                    self.em.result("error_during_execution", true, &last_usage, n_turns, Some(&e));
                    self.em.note(&format!("请求失败: {e}"));
                    return;
                }
            };

            // ---- assistant 定稿（content 与 delta 累积同源）----
            let usage = est_usage(&self.messages, &reply.text);
            last_usage = usage.clone();
            let mut content: Vec<Value> = vec![];
            if !reply.text.trim().is_empty() {
                content.push(json!({"type":"text","text":reply.text}));
            }
            let mut openai_calls = vec![];
            let mut block_index = 1usize;
            for tc in &reply.tool_calls {
                self.tool_seq += 1;
                let id = format!("toolu_{:08x}", self.tool_seq);
                // 流式补发（前端 live 块）：content_block_start + 原子 input_json_delta
                self.em.tool_use_start(block_index, &id, &tc.name);
                let args_str = serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".into());
                self.em.tool_input_delta(block_index, &args_str);
                content.push(json!({"type":"tool_use","id":id,"name":tc.name,"input":tc.arguments}));
                openai_calls.push(json!({
                    "id": id, "type": "function",
                    "function": {"name": tc.name, "arguments": args_str},
                }));
                block_index += 1;
            }
            let stop = if openai_calls.is_empty() { "end_turn" } else { "tool_use" };
            self.em.assistant_final(content.clone(), stop, &usage);
            self.messages.push(json!({
                "role": "assistant",
                "content": if reply.text.is_empty() && !openai_calls.is_empty() {
                    Value::Null
                } else {
                    json!(reply.text)
                },
                "tool_calls": openai_calls,
            }));

            if reply.tool_calls.is_empty() {
                // ---- 收尾 ----
                let dur = t0.elapsed().as_millis() as u64;
                let _ = dur;
                self.em.result("success", false, &usage, n_turns, None);
                if self.em.quiet {
                    // -p 模式：最终文本打到 stdout（人类消费）
                    println!("{}", reply.text);
                }
                return;
            }

            // ---- 工具执行（串行；每个 tool_use 必须有 tool_result 再进下一请求）----
            let calls: Vec<(String, String, Value)> = content
                .iter()
                .filter(|b| b.get("type").and_then(|v| v.as_str()) == Some("tool_use"))
                .map(|b| {
                    (
                        b.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        b.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        b.get("input").cloned().unwrap_or(Value::Null),
                    )
                })
                .collect();
            for (tid, name, input) in calls {
                let outcome = self.exec_tool(&tid, &name, &input).await;
                match outcome {
                    Ok(out) => {
                        self.em.tool_result(&tid, &out, false);
                        self.messages.push(json!({"role":"tool","tool_call_id":tid,"content":out}));
                    }
                    Err(ToolErr::Denied(msg)) => {
                        self.em.tool_result(&tid, &msg, true);
                        self.messages.push(json!({"role":"tool","tool_call_id":tid,"content":msg}));
                    }
                    Err(ToolErr::Interrupted) => {
                        self.em.tool_result(&tid, "[Request interrupted by user]", true);
                        self.messages.push(json!({"role":"tool","tool_call_id":tid,"content":"[Request interrupted by user]"}));
                        self.handle_interrupt("", &mut last_usage, n_turns, t0);
                        return;
                    }
                }
            }
            // 继续下一模型请求
        }
    }

    /// 单工具执行（bash 先审批）。中断传播为 ToolErr::Interrupted。
    async fn exec_tool(&mut self, tid: &str, name: &str, input: &Value) -> Result<String, ToolErr> {
        if name == "bash" {
            let allowed = self.ask_perm(tid, name, input).await?;
            if !allowed {
                return Err(ToolErr::Denied("User denied via qweb".into()));
            }
        }
        let Agent { cwd, home, inter, .. } = self;
        let fut = async {
            match name {
                "read_file" => tools::read_file(cwd, input).await,
                "write_file" => tools::write_file(cwd, input).await,
                "edit" => tools::edit(cwd, input).await,
                "bash" => tools::bash(cwd, home, input).await,
                "glob" => tools::glob(cwd, input).await,
                "grep" => tools::grep(cwd, input).await,
                other => Err(format!("unknown tool: {other}")),
            }
        };
        tokio::pin!(fut);
        tokio::select! {
            r = &mut fut => r.map_err(ToolErr::Denied), // 工具错误 = 可回复给模型的失败（is_error）
            _ = inter.recv() => Err(ToolErr::Interrupted),
        }
    }

    /// bash 审批：control_request → 等 control_response（同 rid）。返回 false=拒。
    /// -p 模式不发卡：--yes 直过，否则拒。
    async fn ask_perm(&mut self, tid: &str, name: &str, input: &Value) -> Result<bool, ToolErr> {
        if self.em.quiet {
            if self.auto_yes {
                self.em.note(&format!("bash 自动批准: {}", input.get("command").and_then(|v| v.as_str()).unwrap_or("")));
                return Ok(true);
            }
            self.em.note(&format!("bash 未批准（-p 模式需 --yes）: {}", input.get("command").and_then(|v| v.as_str()).unwrap_or("")));
            return Ok(false);
        }
        let rid = crate::proto::uuid();
        self.em.ask_perm(&rid, tid, name, input);
        loop {
            tokio::select! {
                m = self.rx.recv() => match m {
                    Some(AgentMsg::Perm { rid: r2, allow }) if r2 == rid => return Ok(allow),
                    Some(AgentMsg::Perm { .. }) => {}                       // 迟到/孤儿回包
                    Some(AgentMsg::User { text }) => self.queued.push_back(text), // 审批期间的用户输入排队
                    None => return Err(ToolErr::Interrupted),               // stdin 关闭
                },
                _ = self.inter.recv() => return Err(ToolErr::Interrupted),   // 中断 = 撤卡
            }
        }
    }

    /// 中断收尾：补中断 user 行 + result（messages 与 UI 对齐策略）
    fn handle_interrupt(&mut self, partial_text: &str, usage: &mut Value, n_turns: u64, t0: std::time::Instant) {
        // 文本中途：丢弃半截 assistant（messages 未入——定稿才入栈，天然丢弃）
        let _ = partial_text;
        let _ = t0;
        self.em.user_note("[Request interrupted by user]");
        self.em.result("success", false, usage, n_turns, None);
        self.em.note("已中断");
        self.drain_interrupt();
    }
}

enum ToolErr {
    Denied(String),     // 工具/审批失败——可回给模型的 is_error 结果
    Interrupted,        // 用户中断——turn 终结
}

fn usage_zero() -> Value {
    json!({"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":0})
}

/// usage 估算（daemon 无 usage）：字符/3。assistant 行与 result 行同值。
pub fn est_usage(messages: &[Value], output_text: &str) -> Value {
    let in_len: usize = messages.iter().map(|m| m.to_string().len()).sum::<usize>()
        + output_text.len();
    json!({
        "input_tokens": (in_len / 3) as u64,
        "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0,
        "output_tokens": (output_text.len() / 3) as u64,
    })
}

impl std::fmt::Display for ToolErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolErr::Denied(m) => write!(f, "{m}"),
            ToolErr::Interrupted => write!(f, "interrupted"),
        }
    }
}

// Arc 引用占位（保持签名稳定，防止后续需要共享 Emitter）
#[allow(dead_code)]
fn _arc_keep(_a: Arc<()>) {}
