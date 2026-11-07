// ccweb-server —— 对照 server.mjs:780-791（listen/启动日志/退出清理）
use std::sync::Arc;

fn reqwest_probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .expect("reqwest probe client")
}

/// CLI 参数（--auth=nopass|password / --password=xxx，等号与空格分隔都收）；
/// env 兜底：CCWEB_AUTH / CCWEB_PASSWORD（systemd unit 传 env 比 args 方便）
fn apply_cli(cfg: &mut ccweb_core::config::Config) {
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = |flag: &str| -> Option<String> {
            a.strip_prefix(&format!("{flag}=")).map(str::to_string).or_else(|| {
                if a == flag { args.next() } else { None }
            })
        };
        if let Some(v) = val("--auth") {
            cfg.auth = match v.as_str() {
                "password" => ccweb_core::config::AuthMode::Password,
                "nopass" => ccweb_core::config::AuthMode::NoPass,
                other => { eprintln!("× --auth 只支持 nopass | password，收到：{other}"); std::process::exit(2); }
            };
        } else if let Some(v) = val("--password") {
            cfg.auth_password = Some(v);
        }
    }
    if cfg.auth == ccweb_core::config::AuthMode::Password && cfg.auth_password.as_deref().unwrap_or("").is_empty() {
        eprintln!("× --auth=password 需要密码：--password=xxx 或 CCWEB_PASSWORD");
        std::process::exit(2);
    }
}

#[tokio::main]
async fn main() {
    let mut cfg = ccweb_core::config::Config::from_env();
    apply_cli(&mut cfg);
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
    // 启动日志逐字对齐 Node 版（(home: 前是两个空格）
    println!("[ccweb] http://0.0.0.0:{}  (home: {}, claude: {})", cfg.port, cfg.child_home, bin);

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
