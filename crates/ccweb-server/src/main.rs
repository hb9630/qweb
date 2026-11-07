// ccweb-server —— 对照 server.mjs:780-791（listen/启动日志/退出清理）
use std::sync::Arc;

fn reqwest_probe_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .expect("reqwest probe client")
}

#[tokio::main]
async fn main() {
    let cfg = ccweb_core::config::Config::from_env();
    let app = Arc::new(ccweb_core::App {
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
