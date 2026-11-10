# qweb

AI coding agent 的流式 Web 工作台（当前对接 Claude Code，引擎架构可挂其他 agent）：对话（stream-json 双向管道）为全宽主角，目录树/编辑器是从标题栏左上（工作目录三件套）派生的一体化浮层（右键全功能文件管理、多 tab 编辑）。Rust 后端（axum/tokio 单二进制，前端全量嵌入）+ React 前端；npm 机制只用于 frontend/，根目录纯 shell 脚本（build.sh / deploy.sh）编排构建与部署。

> 2026-11-06 从 `keeper/deploy/qweb` 拆出独立仓库；2026-11-07 后端移植 Rust（Node 版已移除，API/WS 契约经双后端逐字节 diff 验证后切换）。

## 目录结构

```
backend/            Rust 后端（cargo workspace 自持：Cargo.toml/lock、.cargo 镜像、target/ 都在这层）
  qweb-core/       业务核心 lib：会话管道/fs API/历史回放/静态嵌入
  qweb-server/     薄 bin：CLI 解析/bind/信号/启动横幅；common.rs 两 bin 共用；
                    bin/desktop.rs = Windows Tauri 桌面壳（--features desktop，仅 win 编译）
frontend/           前端（React + TypeScript + Vite）——js/mjs 全部收在这层：依赖自持，测试也在这
  src/ChatPanel     对话区（chat-first 布局底层主角，头部即全局标题栏：cwd chip 开关目录树 / ▾ 历史工作目录 / 换目录）
  src/DirPicker     工作目录选择器（面包屑自由导航 + ✓ 确认；树锁死工作目录内，换目录唯一入口）
  src/Explorer      目录树浮层（标题栏下方垂到底；右键菜单、多选、拖放、上传/下载；独立 X 关闭）
  src/Editor        编辑器浮层（贴树右侧；tab 管理与编辑）
  test/             node 测试（playwright UI 冒烟 + 服务端 e2e/resume + esbuild/jsdom 组件测试；stubs/ 为 esbuild 别名桩）
build.sh            根目录唯一编排脚本（make/make install/make clean 语义）：构建出 ./qweb；desktop 出 Windows 桌面版 ./qweb-desktop.exe；deploy（= install）装 /usr/local/qweb + systemd；clean 清产物
restart.sh          本机快速迭代：构建 + 重启 18090 服务（nohup ./restart.sh &；活会话断开，刷新自动 resume）
```

npm 机制只存在于 frontend/ 内部（install/dev/build 走 vite）；cargo 一切在 backend/ 内；根目录无 package.json、无 Cargo 文件。

## 快速开始

```bash
(cd frontend && npm install)          # 前端依赖（Rust 侧经 backend/.cargo/config.toml 走 rsproxy 镜像）
./build.sh                            # 全量构建：frontend/dist + 根目录 ./qweb（~19MB 单文件）
./build.sh clean                      # 清产物：./qweb、frontend/dist、cargo target
QWEB_NO_RUST=1 ./build.sh            # 只出前端（开发够用）

(cd backend && cargo run -p qweb-server)   # Rust 后端开发跑（debug 态 dist 从磁盘读，前端重建无需重编）
(cd frontend && npm run dev)                # 前端开发（vite HMR）
```

### Windows 本地开发：MSVC 环境的两个坑

前置：VS Build Tools（MSVC v142 + Windows 10 SDK）+ Rust `stable-x86_64-pc-windows-msvc`。

**坑 1**：Git Bash 环境下 `cargo build` 链接期报
`linking with link.exe failed` / `link: extra operand '....rcgu.o'` / `Try 'link --help'`——
这是 **GNU coreutils 的 `link`**（建硬链接的小工具，Git for Windows 装在
`C:\Program Files\Git\usr\bin\link.exe`，还有 `coreutils\bin` 变体）冒充了 MSVC 链接器：
rustc 按 PATH 找 `link.exe`，Git 的 usr/bin 抢在前面，它不认识链接器参数。真 MSVC
link.exe 在 VS Build Tools 里且**不在 PATH**（需 vcvars 激活），所以裸 cargo 必然中招。

**坑 2**：vcvars64.bat 可能**检测不到已装的 Windows 10 SDK**（注册表探测失败等）——
INCLUDE 里只有 MSVC 头文件，编 aws-lc-sys（reqwest rustls 依赖）时报
`fatal error C1083: windows.h: No such file or directory`。SDK 明明装在
`C:\Program Files (x86)\Windows Kits\10\`（版本按实装调整），需手动补路径。

**解法**：构建跑在 vcvars 环境 + 手动补 SDK 路径的 bat 里（两个坑一次全防）：

```bat
@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set K=C:\Program Files (x86)\Windows Kits\10
set INCLUDE=%INCLUDE%;%K%\Include\10.0.19041.0\ucrt;%K%\Include\10.0.19041.0\um;%K%\Include\10.0.19041.0\shared;%K%\Include\10.0.19041.0\winrt;%K%\Include\10.0.19041.0\cppwinrt
set LIB=%LIB%;%K%\Lib\10.0.19041.0\ucrt\x64;%K%\Lib\10.0.19041.0\um\x64
cd /d <repo>\backend && cargo build --release -p qweb-server %*
```

注意：重构建前先停在跑的 qweb/qweb-desktop 进程——Windows 锁住运行中的 exe，
cargo 换产物时报 `failed to remove file ... (os error 5)`。

**Windows 桌面版**（Tauri + WebView2 壳）：`./build.sh desktop` → 根目录 `qweb-desktop.exe`
（~25MB，GUI 子系统无控制台黑窗，claude 子进程经 CREATE_NO_WINDOW 抑制控制台弹窗）。
双击即开原生窗口：进程内起 axum（默认 `127.0.0.1:随机空闲端口`，不暴露局域网、
不与浏览器版撞口；显式 `--port`/`QWEB_PORT` 时按配置监听），窗口直接导航之——前端
零改动，与浏览器版同构。**关窗 = 退出并结束全部会话子进程**。首次打开工作目录自动
落到"最近有会话的目录"（WebView2 存储全新无记忆时的智能默认）。


正式部署 `./build.sh deploy`（见下）。

## 部署

按目标环境取用，四种形态同一份代码：

- **裸跑**：`(cd backend && cargo run)`——开发态（dist 读磁盘）
- **单文件**：根目录 `./qweb`（./build.sh 产物，Rust 二进制 + 前端全量嵌入，~19MB；原 SEA 形态 137MB 的 1/7，常驻内存 ~8MB vs Node ~52MB；git 忽略）——拷到任何装了 claude 的机器，任意目录 `./qweb` 即跑，无任何运行时依赖；**起来后默认自动开浏览器**（`--no-browser` 关）
- **Windows 桌面版**：`./build.sh desktop` → `./qweb-desktop.exe`（Tauri + WebView2 原生窗口，双击即用；见上"Windows 本地开发"）——Windows 的默认形态
- **./build.sh deploy**：假如使用 systemd 的话（Linux 服务器常态），构建+安装一条命令——开发目录只是源码，服务装在系统位置、与源码解耦，升级 = 重跑 `./build.sh deploy`：
  1. 全量构建出 Rust 单文件（Linux 目标需 linux 构建产物——目标机构建或交叉编译）
  2. 安装 **`/usr/local/qweb`**（自包含单文件本体）
  3. 生成 systemd 单元（自适应 User/HOME/端口，默认 **18090**；`QWEB_PORT=xxx ./build.sh deploy` 改端口）→ 安装重启 → 健康检查

## 与 Node 版的刻意差异（Rust 版）

1. 畸形请求（`//` 开头路径、非法 `%` 转义）→ 400（Node 曾挂死连接）
2. 目录下载内建 tar+flate2（不依赖系统 tar 二进制；客户端中断即刻停止打包）
3. claude spawn 失败 → 广播 `{t:"exit",code:null}` + 迟到订阅者补发 exit 帧（Node 挂死不回）
4. body 超限/中断 → 413/400（Node 吊连接不回包）
5. 未知 `/ws/{id}` 升级 → 404（Node 裸断 socket）
6. `PUT /api/fs/file` 的 `size` = JS UTF-16 码元数（与 Node `.length` 对齐；GET 的 `size` 为字节数——继承 Node 原有不一致）
7. files 排序 localeCompare → 大小写不敏感字节比较（ASCII 序一致）；`/api/history` 分组顺序随文件系统枚举序（Node 同样非确定，前端按 cwd 过滤不依赖组序）

## CLI 参数

```bash
./qweb -p 18090                # 指定端口（--port=18090 等价）
./qweb --home /data/ws --single
./qweb --no-browser            # 不自动开浏览器（服务器/反代部署）
./qweb --help                  # 完整用法；--version 查版本
```

启动横幅始终打印生效参数（含默认值），端口带来源标注：

```
[qweb] v0.1.0  http://0.0.0.0:18090
       port: 18090 (-p)   home: /Users/huangbin
       claude: /usr/local/bin/claude   auth: nopass   single: off
```

优先级 **CLI > env > 默认**；无法识别的参数直接报错退出（exit 2）。

## 环境变量

systemd unit 传 env 比 args 方便，env 形态全量保留（与上表 CLI 一一对应）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `QWEB_PORT` | 8090 | 监听端口 |
| `QWEB_HOME` | `$HOME` | 工作区根（树根/会话 cwd 钳制边界） |
| `QWEB_SINGLE` | – | `=1` 发布单会话形态：至多一个活会话，前端隐藏会话切换 |
| `QWEB_CLAUDE` | PATH 探测 | claude 可执行文件路径覆盖 |
| `QWEB_NO_BROWSER` | – | `=1` 同 `--no-browser`（不自动开浏览器） |
| `QWEB_NO_RUST` | – | `=1` 时 ./build.sh 跳过 Rust 单文件打包 |

## 访问认证（code-server 同款语义）

```bash
./qweb --auth=nopass                      # 默认：无认证
./qweb --auth=password --password=xxx     # 密码模式
QWEB_AUTH=password QWEB_PASSWORD=xxx ./qweb   # env 形态（systemd unit 传 env 更方便）
```

- 密码模式：全部 HTTP/WS 需会话 cookie；未登录页面 303 → `/login`（内建深色登录页），API 401，WS 拒绝
- 登录成功签发 30 天 `qweb_auth` cookie（HttpOnly/SameSite=Lax）；`/logout` 登出销毁
- 会话 token 内存态：**服务重启后需重新登录**；密码为常数时间比较
- base_path 兼容：`/login` 已入路由锚点表，反代前缀下照常工作

## 路由：零配置 base_path

前端资源全相对引用（vite `base:'./'`），服务端把路径中最早出现的路由锚点（`/api/` `/ws/` `/assets/` …）之前的内容一律当 base 剥掉——nginx 剥前缀、透传带前缀、本地根形态，三种姿势同一套逻辑，反代无需任何配置。

## 会话模型

- 每个 tab = 一个长驻 claude 进程（`--output-format stream-json` 双向管道），关 tab 才 kill
- 刷新页面经 ring buffer 回放恢复完整对话；进程空闲 20min 自动回收
- resume 幂等：同一官方会话已有活进程时重复 POST 返回既有会话，不重复 spawn
- 工作目录 = 左栏目录树右键"设为工作目录"（唯一入口）；换目录 = 新会话（cwd 在 spawn 时固化）

## 权限审批 / 图片附件 / 插话

spawn 恒带 `--permission-prompt-tool stdio`（CLI ≥2.1，SDK canUseTool 同款带内通道）：

- **审批**：无放行清单匹配的工具调用不再被 headless 静默拒绝，而是以 `can_use_tool`
  control_request 到达前端渲染成琥珀色授权卡片（工具名 + **人话化参数**——command/
  file_path 等关键字段大字展示、其余键小字 k-v，裸 JSON 仅兜底 + 允许/拒绝）；决定经
  `{"t":"perm","rid":..., "allow":...}` 回写 stdin，deny 文案会作为 tool_result 反馈给模型。
  询问帧入回放缓冲——刷新页面后未决卡片自动恢复。allow 回包按协议带原 input 作
  `updatedInput`（2.1.212 逐字实测的 wire 格式）。
- **@ 文件引用**：输入框打 `@` 联想工作目录内文件/目录（可 `dir/` 逐级下钻，↑↓ 选、
  Tab/Enter 补全），补出相对路径交模型按 cwd 解析。图片上传入口已移除（目录树支持上传；
  stdin `source.base64` 协议面保留）。
- **插话（steering）**：回复进行中发送的消息**不进消息流**——钉在输入框上方的
  排队条里（↑ 撤回到输入框——多条撤回按提交顺序回填，早的上面晚的下面；✕ 删除），
  本轮 `result` 到达时整队自动送出上屏，与 CLI 轮末送达的时机一致。
- 渲染：子代理事件（`parent_tool_use_id` 非空）缩进弱化；思考 token 增量计数
  （"思考中… ~N tokens"）；MCP 工具名 `mcp__srv__tool` 美化为 `mcp:srv/tool`。

## 测试

```bash
node frontend/test/e2e-test.mjs http://127.0.0.1:18090/     # 端到端冒烟：入口→会话→WS→claude 回复（需 claude 可用）
node frontend/test/resume-test.mjs <base> <sid> <cwd>       # resume 幂等/续聊验证
node frontend/test/fix3-verify.mjs [base]                   # 三修复回归：init 免首消息/模式切换回包/ctx 分子真值
cd frontend && node test/askform-check.mjs                  # AskUserQuestion 表单全链路（单选/多选/其他输入，真会话驱动）
cd frontend && node test/replay-check.mjs                   # 刷新回放：表单落定卡选项齐全高亮还原
cd frontend && node test/multi-select-test.mjs              # playwright UI 冒烟（多选/拖放/跟随等）
```

## License

Apache-2.0（见 [LICENSE](LICENSE)）。
