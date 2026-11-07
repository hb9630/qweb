// 环境与入口解析 —— 对照 server.mjs:14-56,101-126
use std::collections::HashMap;
use std::path::Path;

pub const IS_WIN: bool = cfg!(windows);

// 对外平台名必须 Node 风格（前端按 darwin/win32 判断）
pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other, // linux 等
    }
}

pub fn homedir() -> String {
    // 与 node os.homedir() 对齐：unix HOME，win USERPROFILE（win 上 HOME 由部署层显式给）
    if IS_WIN {
        std::env::var("USERPROFILE").unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    }
}

#[derive(Clone, PartialEq)]
pub enum AuthMode {
    NoPass,
    Password,
}

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub auth: AuthMode,
    pub auth_password: Option<String>,
    pub child_home: String, // 工作区根（= 子进程 HOME），正斜杠规范
    pub single: bool,
    pub keeperd_url: String,
    pub projects: String,   // ~/.claude/projects
    pub ctxwin_path: String, // ~/.claude/ccweb-ctxwin.json
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("CCWEB_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(8090);
        let child_home = super::util::P(&std::env::var("CCWEB_HOME").ok().filter(|s| !s.is_empty())
            .unwrap_or_else(homedir));
        let jj = |a: &str, b: &str, c: &str| format!("{a}/{b}/{c}");
        let auth = match std::env::var("CCWEB_AUTH").as_deref() {
            Ok("password") => AuthMode::Password,
            _ => AuthMode::NoPass,
        };
        Self {
            port,
            auth,
            auth_password: std::env::var("CCWEB_PASSWORD").ok().filter(|s| !s.is_empty()),
            single: std::env::var("CCWEB_SINGLE").as_deref() == Ok("1"),
            keeperd_url: std::env::var("KEEPERD_URL").ok().filter(|s| !s.is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:7998".into()),
            projects: jj(&child_home, ".claude", "projects"),
            ctxwin_path: jj(&child_home, ".claude", "ccweb-ctxwin.json"),
            child_home,
        }
    }

    /// claude 入口：env 显式 > win32 npm-global cli.js > 惯例路径 > PATH。
    /// 返回 (bin, pre)：win 上 node 直跑 cli.js 时 pre=[cli]。
    pub fn claude_cmd(&self) -> (String, Vec<String>) {
        if let Ok(v) = std::env::var("CCWEB_CLAUDE") {
            if !v.is_empty() { return (v, vec![]); }
        }
        if IS_WIN {
            let appdata = std::env::var("APPDATA").ok().filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("{}/AppData/Roaming", homedir()));
            let cli = format!("{appdata}/npm/node_modules/@anthropic-ai/claude-code/cli.js");
            if Path::new(&cli).exists() { return ("node".into(), vec![cli]); }
            return ("claude".into(), vec![]); // 退路：PATH 里的 claude.cmd
        }
        for c in [
            "/root/.npm-global/bin/claude",
            &format!("{}/.npm-global/bin/claude", self.child_home),
            "/usr/local/bin/claude",
        ] {
            if Path::new(c).exists() { return (c.into(), vec![]); }
        }
        ("claude".into(), vec![])
    }

    /// 子进程环境：父环境全量 + HOME 覆盖 + TERM（server.mjs CHILD_ENV）
    pub fn child_env(&self) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.insert("HOME".into(), self.child_home.clone());
        env.insert("TERM".into(), "xterm-256color".into());
        env
    }
}
