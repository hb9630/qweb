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
    pub ctxwin_path: String, // ~/.claude/qweb-ctxwin.json
    pub dsweb_url: String,    // qtom 引擎模型端点（空 = 引擎关闭）
    pub dsweb_token: String,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("QWEB_PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(8090);
        let auth = match std::env::var("QWEB_AUTH").as_deref() {
            Ok("password") => AuthMode::Password,
            _ => AuthMode::NoPass,
        };
        let mut cfg = Self {
            port,
            auth,
            auth_password: std::env::var("QWEB_PASSWORD").ok().filter(|s| !s.is_empty()),
            single: std::env::var("QWEB_SINGLE").as_deref() == Ok("1"),
            keeperd_url: std::env::var("KEEPERD_URL").ok().filter(|s| !s.is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:7998".into()),
            child_home: String::new(),
            projects: String::new(),
            ctxwin_path: String::new(),
            dsweb_url: std::env::var("QWEB_DSWEB_URL").ok().filter(|s| !s.is_empty()).unwrap_or_default(),
            dsweb_token: std::env::var("QWEB_DSWEB_TOKEN").ok().filter(|s| !s.is_empty()).unwrap_or_default(),
        };
        cfg.set_home(&std::env::var("QWEB_HOME").ok().filter(|s| !s.is_empty())
            .unwrap_or_else(homedir));
        cfg
    }

    /// 覆盖工作区根并同步派生路径（from_env 与 CLI --home 共用同一推导）
    pub fn set_home(&mut self, home: &str) {
        self.child_home = super::util::P(home);
        self.projects = format!("{}/.claude/projects", self.child_home);
        self.ctxwin_path = format!("{}/.claude/qweb-ctxwin.json", self.child_home);
    }

    /// claude 入口：env 显式 > win32 npm-global（新版原生 exe > 旧版 cli.js）> 惯例路径 > PATH。
    /// 返回 (bin, pre)：win 上 node 直跑 cli.js 时 pre=[cli]。
    pub fn claude_cmd(&self) -> (String, Vec<String>) {
        if let Ok(v) = std::env::var("QWEB_CLAUDE") {
            if !v.is_empty() { return (v, vec![]); }
        }
        if IS_WIN {
            let appdata = std::env::var("APPDATA").ok().filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("{}/AppData/Roaming", homedir()));
            let base = format!("{appdata}/npm/node_modules/@anthropic-ai/claude-code");
            let exe = format!("{base}/bin/claude.exe");
            if Path::new(&exe).exists() { return (exe, vec![]); } // 新版布局：原生 exe 真身（npm shim 只转发，PATH 上无 claude.exe）
            let cli = format!("{base}/cli.js");
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

    /// qtom 引擎是否可用（模型端点已配置即算；二进制探测见 qtom_cmd）
    pub fn dsweb_enabled(&self) -> bool {
        !self.dsweb_url.is_empty()
    }

    /// qtom 入口：env 显式 > 与本进程同目录（win 产物带 .exe）> PATH（与 claude_cmd 同策略）。
    /// qtom 自读 transcript：其 $HOME/.claude/projects 随 child_env 的 HOME 对齐 cfg.projects。
    pub fn qtom_cmd(&self) -> String {
        if let Ok(v) = std::env::var("QWEB_QTOM") {
            if !v.is_empty() { return v; }
        }
        if let Ok(me) = std::env::current_exe() {
            if let Some(dir) = me.parent() {
                #[cfg(windows)]
                let names = ["qtom.exe", "qtom"];
                #[cfg(not(windows))]
                let names = ["qtom"];
                for name in names {
                    let candidate = dir.join(name);
                    if candidate.exists() {
                        return candidate.to_string_lossy().into_owned();
                    }
                }
            }
        }
        "qtom".into()
    }
}
