// qweb-desktop —— Windows 桌面壳（Tauri + WebView2）。仅 --features desktop 编译；
// 其他平台/浏览器形态用 qweb（qweb-desktop.rs 的 compile_error 双保险）。
//
// 架构：Tauri 只做窗口壳——进程内起 axum（默认 127.0.0.1:随机空闲端口，显式
// --port/QWEB_PORT 时用配置端口并照常 0.0.0.0 监听），窗口直接导航该 URL。
// 前端零改动（同源 fetch/WS 全通），浏览器版与桌面版共享同一服务实现。
// 关窗 = 退出：tauri run 返回后统一 shutdown（杀全部 claude 子进程）再 exit。
// GUI 子系统：不出现控制台黑窗口（完整桌面应用形态；println 横幅随之不可见，日志走 err 重定向）
#![cfg_attr(windows, windows_subsystem = "windows")]
#![cfg(feature = "desktop")]

#[cfg(not(windows))]
compile_error!("qweb-desktop 仅 Windows 编译（其他平台用 qweb 浏览器版）");

#[path = "../common.rs"]
mod common;

use std::sync::Arc;

fn main() {
    // WebView2 默认遵循系统代理：bypass 列表（<local> 等）只豁免无点主机名、不豁免
    // IP 字面量——系统代理开启时对 http://127.0.0.1:<port> 的全部请求（页面/JS/API/WS）
    // 被代理劫持（远端连不回本机 → 秒级超时，"桌面版比网页版慢"即来于此）。
    // 桌面窗口只加载进程内本机服务，直接禁代理一劳永逸（须在 WebView2 创建前设好）。
    // 追加式：外部注入的同名 env（如 --remote-debugging-port 诊断）不覆盖
    let extra = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        format!("{extra} --proxy-server=direct:// --proxy-bypass-list=*"),
    );
    let mut cfg = qweb_core::config::Config::from_env();
    let cli = common::apply_cli(&mut cfg);
    // 桌面版默认本机随机空闲口（免端口冲突/免暴露局域网）；显式配置端口 = 用户想固定访问
    let explicit_port = cli.port_from != "默认";
    let addr = format!(
        "{}:{}",
        if explicit_port { "0.0.0.0" } else { "127.0.0.1" },
        if explicit_port { cfg.port } else { 0 },
    );

    // axum 跑在专属 tokio runtime（tauri 的 run 循环占主线程；runtime 须存活到进程末）。
    // build_app/FsHub::new 构造即抓 Handle::current、spawn_background 内部 tokio::spawn
    // ——都必须在 runtime 上下文里调（block_on 内），否则 "no reactor running" panic
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let (app, port, bind) = rt.block_on(async {
        let app: Arc<qweb_core::App> = common::build_app(&cfg);
        qweb_core::spawn_background(app.clone());
        let listener = tokio::net::TcpListener::bind(&addr)
            .await
            .unwrap_or_else(|e| panic!("监听 {addr} 失败: {e}"));
        let local = listener.local_addr().expect("local addr");
        let srv_app = app.clone();
        tokio::spawn(async move {
            axum::serve(listener, qweb_core::router(srv_app))
                .await
                .expect("server error");
        });
        (app, local.port(), local.to_string())
    });
    cfg.port = port;
    common::banner(&cfg, cli.port_from, &bind);
    println!("       ui: 桌面窗口（关闭窗口即退出并结束全部会话子进程）");

    let url: tauri::Url = format!("http://127.0.0.1:{port}").parse().expect("url");
    tauri::Builder::default()
        .setup(move |tauri_app| {
            tauri::WebviewWindowBuilder::new(
                tauri_app,
                "main",
                tauri::WebviewUrl::External(url),
            )
            .title("qweb")
            .inner_size(1366.0, 860.0)
            .min_inner_size(720.0, 480.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri run");

    // 所有窗口已关：清理 claude 子进程后退出（kill_on_drop 之外的双保险）
    rt.block_on(async {
        qweb_core::shutdown(&app).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    });
    std::process::exit(0);
}
