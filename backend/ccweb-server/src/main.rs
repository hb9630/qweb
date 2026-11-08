// ccweb-server —— CLI 解析 + listen/启动横幅/退出清理（业务在 ccweb-core）
// aws-lc（rustls 默认密码库）汇编在 macOS ld64 下 "could not create compact unwind" 是已知噪音，
// 无功能影响；reqwest 0.13 无 ring 后台 feature，此处静音 linker_messages
#![allow(linker_messages)]
use std::sync::Arc;

fn reqwest_probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .expect("reqwest probe client")
}

const USAGE: &str = "\
ccweb —— Claude Code Web 壳

用法: ccweb [选项]

选项:
  -p, --port <PORT>     监听端口（默认 8090；env CCWEB_PORT）
      --home <PATH>     工作区根 = 子进程 HOME（默认 $HOME；env CCWEB_HOME）
      --single          单会话形态：至多一个活会话（env CCWEB_SINGLE=1）
      --auth <MODE>     nopass | password（默认 nopass；env CCWEB_AUTH）
      --password <PWD>  password 模式密码（env CCWEB_PASSWORD）
      --dsweb <URL>     qtom 引擎模型端点（dsweb daemon；env CCWEB_DSWEB_URL）
      --dsweb-token <T> 端点令牌（env CCWEB_DSWEB_TOKEN）
  -h, --help            打印本帮助
  -V, --version         打印版本

等号与空格分隔都收：--port=18090 与 --port 18090 等价；优先级 CLI > env > 默认。";

/// 取参数值：--flag=v 或 --flag v（等号与空格分隔都收）
fn val(flag: &str, a: &str, args: &mut impl Iterator<Item = String>) -> Option<String> {
    a.strip_prefix(&format!("{flag}=")).map(str::to_string).or_else(|| {
        if a == flag { args.next() } else { None }
    })
}

fn parse_port(v: &str) -> u16 {
    v.parse::<u16>().unwrap_or_else(|_| {
        eprintln!("× 端口需要 1-65535 的数字，收到：{v}");
        std::process::exit(2);
    })
}

/// CLI 参数解析（优先级 CLI > env > 默认；systemd unit 传 env 比 args 方便所以 env 兜底保留）。
/// 返回端口来源标注（启动横幅用：--port / CCWEB_PORT / 默认）。
fn apply_cli(cfg: &mut ccweb_core::config::Config) -> &'static str {
    let mut port_from = if std::env::var("CCWEB_PORT").map(|v| v.parse::<u16>().is_ok()).unwrap_or(false) {
        "CCWEB_PORT"
    } else {
        "默认"
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if a == "-p" {
            let v = args.next().unwrap_or_else(|| { eprintln!("× -p 需要端口号"); std::process::exit(2) });
            cfg.port = parse_port(&v);
            port_from = "-p";
        } else if let Some(v) = val("--port", &a, &mut args) {
            cfg.port = parse_port(&v);
            port_from = "--port";
        } else if let Some(v) = val("--home", &a, &mut args) {
            if v.is_empty() { eprintln!("× --home 不能为空"); std::process::exit(2); }
            cfg.set_home(&v);
        } else if a == "--single" {
            cfg.single = true;
        } else if let Some(v) = val("--auth", &a, &mut args) {
            cfg.auth = match v.as_str() {
                "password" => ccweb_core::config::AuthMode::Password,
                "nopass" => ccweb_core::config::AuthMode::NoPass,
                other => { eprintln!("× --auth 只支持 nopass | password，收到：{other}"); std::process::exit(2); }
            };
        } else if let Some(v) = val("--password", &a, &mut args) {
            cfg.auth_password = Some(v);
        } else if let Some(v) = val("--dsweb", &a, &mut args) {
            if v.is_empty() { eprintln!("× --dsweb 不能为空"); std::process::exit(2); }
            cfg.dsweb_url = v;
        } else if let Some(v) = val("--dsweb-token", &a, &mut args) {
            cfg.dsweb_token = v;
        } else if a == "--help" || a == "-h" {
            println!("{USAGE}");
            std::process::exit(0);
        } else if a == "--version" || a == "-V" {
            println!("ccweb {}", env!("CARGO_PKG_VERSION"));
            std::process::exit(0);
        } else {
            eprintln!("× 无法识别的参数：{a}（--help 查看用法）");
            std::process::exit(2);
        }
    }
    if cfg.auth == ccweb_core::config::AuthMode::Password && cfg.auth_password.as_deref().unwrap_or("").is_empty() {
        eprintln!("× --auth=password 需要密码：--password=xxx 或 CCWEB_PASSWORD");
        std::process::exit(2);
    }
    port_from
}

#[tokio::main]
async fn main() {
    let mut cfg = ccweb_core::config::Config::from_env();
    let port_from = apply_cli(&mut cfg);
    let app = Arc::new(ccweb_core::App {
        auth: ccweb_core::auth::AuthState::new(cfg.auth.clone(), cfg.auth_password.clone()),
        cfg: cfg.clone(),
        fs_hub: ccweb_core::fswatch::FsHub::new(),
        sessions: Default::default(),
        ctxwin: std::sync::Arc::new(ccweb_core::ctxwin::CtxWin::new(cfg.ctxwin_path.clone())),
        http: ccweb_core::Http {
            probe: reqwest_probe_client(),
            proxy: reqwest::Client::new(),
        },
    });
    ccweb_core::spawn_background(app.clone());

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("监听 {addr} 失败: {e}"));

    let (bin, _) = cfg.claude_cmd();
    // 启动横幅：始终打印生效参数（含默认值），端口带来源标注（--port / CCWEB_PORT / 默认）
    let auth = match cfg.auth {
        ccweb_core::config::AuthMode::NoPass => "nopass",
        ccweb_core::config::AuthMode::Password => "password",
    };
    println!("[ccweb] v{}  http://0.0.0.0:{}", env!("CARGO_PKG_VERSION"), cfg.port);
    println!("       port: {} ({})   home: {}", cfg.port, port_from, cfg.child_home);
    println!("       claude: {}   auth: {}   single: {}", bin, auth, if cfg.single { "on" } else { "off" });
    if cfg.dsweb_enabled() {
        println!("       qtom: {}   dsweb: {}", cfg.qtom_cmd(), cfg.dsweb_url);
    } else {
        println!("       qtom: off（--dsweb 配置后可用）");
    }

    // 退出清理：结束所有 claude 子进程，防孤儿
    let shutdown_app = app.clone();
    tokio::spawn(async move {
        wait_signal().await;
        ccweb_core::shutdown(&shutdown_app).await;
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        std::process::exit(0);
    });

    axum::serve(listener, ccweb_core::router(app))
        .await
        .expect("server error");
}

async fn wait_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
