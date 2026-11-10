# qweb

[English](README.md) | **简体中文**

AI coding agent 的流式 Web 工作台——当前对接 Claude Code，引擎架构可挂其他 agent。

对话是全宽主角；目录树与编辑器是从标题栏唤出的一体化浮层。单个自包含二进制承载全部 UI，无任何运行时依赖。

## 特性

- **流式对话**——实时输出、ESC 打断、回复中插话排队、刷新安全（会话经缓冲区回放恢复）、任意历史会话续聊（resume）
- **文件管理**——目录树右键全功能（重命名/移动/上传/下载）、多 tab 编辑器、输入框 `@` 引用文件
- **权限审批**——工具调用渲染成人话卡片（command、file_path 等关键字段大字展示），一键允许/拒绝
- **多引擎**——新会话按引擎切换；当前 Claude Code，其他 agent 可接入
- **两种形态、同一份代码**——单文件服务（浏览器版）与 Windows 原生桌面版
- **认证可选**——密码模式（内建登录页）或本地免认证
- **反代友好**——base path 零配置：nginx 带或不带路径前缀都直接工作

## 快速开始

```bash
git clone https://github.com/hb9630/qweb && cd qweb
(cd frontend && npm install)   # Rust 依赖经 backend/.cargo 镜像
./build.sh                     # → ./qweb（单文件 ~19MB，前端全量嵌入）
./qweb                         # 自动开浏览器；--no-browser 关闭
```

**Windows 桌面版**（Tauri + WebView2，需 MSVC Build Tools + Rust `x86_64-pc-windows-msvc`）：

```bat
buildcc.bat --features desktop --bin qweb-desktop
:: 包装 vcvars + cargo；产物：backend\target\release\qweb-desktop.exe，双击即开原生窗口
```

关窗即退出并结束全部会话子进程。

**Linux 服务器 systemd 部署**：`./build.sh deploy` 安装到 `/usr/local/qweb` 并生成 systemd 单元（默认端口 18090）。

## 命令行

```bash
./qweb -p 18090                # 端口（QWEB_PORT）
./qweb --home /data/ws         # 工作区根（QWEB_HOME）
./qweb --single                # 单会话形态（QWEB_SINGLE=1）
./qweb --auth password --password=xxx   # 密码认证（QWEB_AUTH/QWEB_PASSWORD）
./qweb --no-browser            # 不自动开浏览器
./qweb --help
```

优先级：CLI > 环境变量 > 默认。启动横幅始终打印生效配置。

## License

Apache-2.0（见 [LICENSE](LICENSE)）。
