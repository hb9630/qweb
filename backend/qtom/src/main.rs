// qtom —— qkeeper 动物园第一只居民（猫）：编码 agent。
// 被	qweb spawn（stdio 说 CC stream-json 同构协议），亦可终端直用：
//   qtom -p "看看这个目录" --yes        # 单发模式
//   qweb 侧：DSWEB_URL/DSWEB_TOKEN env + 长驻 stdio 模式
mod agent;
mod client;
mod proto;
mod tools;
mod transcript;

use agent::{Agent, AgentMsg};
use client::DsClient;
use proto::Emitter;
use serde_json::Value;
use transcript::Transcript;

const USAGE: &str = "\
qtom —— 编码 agent 猫（qkeeper 动物园）

用法：
  qtom [选项]                      stdio 长驻模式（qweb 宿主）
  qtom -p <prompt> [选项]          单发模式（终端直用）

选项：
  --cwd <dir>        会话目录（默认当前目录）
  --resume <sid>     恢复会话（transcript 再水化）
  --projects <dir>   transcript 根（默认 ~/.claude/projects）
  --dsweb-url <url>  OpenAI 兼容端点（env DSWEB_URL）
  --dsweb-token <t>  端点令牌（env DSWEB_TOKEN）
  --yes              -p 模式下自动批准 bash
  -h | --help        本帮助";

fn main() {
    let mut cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into());
    let mut resume: Option<String> = None;
    let mut projects = {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/.claude/projects")
    };
    let mut url = std::env::var("DSWEB_URL").unwrap_or_default();
    let mut token = std::env::var("DSWEB_TOKEN").unwrap_or_default();
    let mut prompt: Option<String> = None;
    let mut yes = false;

    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--cwd" => cwd = val(&mut args, &a),
            "--resume" => resume = Some(val(&mut args, &a)),
            "--projects" => projects = val(&mut args, &a),
            "--dsweb-url" => url = val(&mut args, &a),
            "--dsweb-token" => token = val(&mut args, &a),
            "-p" | "--print" => prompt = Some(val(&mut args, &a)),
            "--yes" => yes = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            _ => eprintln!("未知参数: {a}（--help 看用法）"),
        }
    }
    if url.is_empty() {
        eprintln!("缺少模型端点：--dsweb-url 或 env DSWEB_URL（--help 看用法）");
        std::process::exit(2);
    }

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    runtime.block_on(run(Args { cwd, resume, projects, url, token, prompt, yes }));
}

struct Args {
    cwd: String,
    resume: Option<String>,
    projects: String,
    url: String,
    token: String,
    prompt: Option<String>,
    yes: bool,
}

fn val(args: &mut impl Iterator<Item = String>, flag: &str) -> String {
    args.next().unwrap_or_else(|| {
        eprintln!("{flag} 需要值");
        std::process::exit(2);
    })
}

async fn run(a: Args) {
    let quiet = a.prompt.is_some(); // -p 模式：事件静默（transcript 照写），结果文本上 stdout
    // 会话身份：resume 沿用 sid（qweb 侧 dedup/锚点依赖），新会话生成 uuid
    let sid = a.resume.clone().unwrap_or_else(proto::uuid);
    let tr = Transcript::open(&a.projects, &a.cwd, &sid);
    let mut em = Emitter::new(quiet, &sid, &a.cwd, tr);

    // resume 再水化
    let (mut messages, max_seq) = match &a.resume {
        Some(_) => transcript::find(&a.projects, &sid)
            .map(|p| transcript::rehydrate(&p))
            .unwrap_or_else(|| {
                em.note(&format!("resume 找不到 transcript {sid}，从空会话开始"));
                (vec![], 0)
            }),
        None => (vec![], 0),
    };
    if !quiet && a.resume.is_some() {
        em.note(&format!("恢复会话 {sid}（{} 条消息）", messages.len()));
    }

    let cli = DsClient::new(&a.url, &a.token);
    let (tx, rx) = agent::spawn_channel();
    let (itx, irx) = agent::interrupt_channel();
    let mut ag = Agent::new(em, cli, &a.cwd, &a.cwd, std::mem::take(&mut messages), max_seq, rx, irx, a.yes);

    match a.prompt {
        Some(p) => {
            // 单发：一条用户消息，跑完退出（stdin 不泵）
            let _ = tx.send(AgentMsg::User { text: p });
            drop(tx);
            ag.run().await;
        }
        None => {
            // stdio 长驻：stdin 泵（按行解析 CC 格式 → 信道）；tx 移交泵后本地 drop，
            // stdin 关闭 → 泵结束 → tx 全 drop → run 循环退出（qweb 关 stdin = 优雅关闭）
            pump_stdin(tx, itx);
            ag.run().await;
        }
    }
}

/// stdin 泵：qweb 写来的三种帧转投 agent 信道。
/// - {"type":"user","message":{"content":"..."|[块]}}         → User
/// - {"type":"control_response","response":{request_id,...}}  → Perm
/// - {"type":"control_request","request":{"subtype":"interrupt"}} → interrupt
fn pump_stdin(tx: tokio::sync::mpsc::UnboundedSender<AgentMsg>, itx: tokio::sync::mpsc::UnboundedSender<()>) {
    tokio::spawn(async move {
        use tokio::io::AsyncBufReadExt;
        let mut buf = String::new();
        let mut reader = tokio::io::BufReader::new(tokio::io::stdin());
        loop {
            buf.clear();
            match reader.read_line(&mut buf).await {
                Ok(0) | Err(_) => break, // stdin 关闭/坏：agent run 循环随 tx drop 退出
                Ok(_) => {}
            }
            let line = buf.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("user") => {
                    if let Some(text) = extract_user_text(&v) {
                        let _ = tx.send(AgentMsg::User { text });
                    }
                }
                Some("control_response") => {
                    let rid = v.pointer("/response/request_id").and_then(|r| r.as_str()).unwrap_or("").to_string();
                    let behavior = v.pointer("/response/response/behavior").and_then(|b| b.as_str()).unwrap_or("");
                    if !rid.is_empty() {
                        let _ = tx.send(AgentMsg::Perm { rid, allow: behavior == "allow" });
                    }
                }
                Some("control_request") => {
                    if v.pointer("/request/subtype").and_then(|s| s.as_str()) == Some("interrupt") {
                        let _ = itx.send(());
                    }
                }
                _ => {} // set_model 等 v1 忽略
            }
        }
    });
}

/// user 帧 content 兼容三形态：字符串 / [{type:text}] / 混有 image 块（忽略图片）
fn extract_user_text(v: &Value) -> Option<String> {
    match v.pointer("/message/content") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Array(items)) => {
            let t: Vec<&str> = items
                .iter()
                .filter(|b| b.get("type").and_then(|x| x.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|x| x.as_str()))
                .collect();
            if t.is_empty() { None } else { Some(t.join("\n")) }
        }
        _ => None,
    }
}
