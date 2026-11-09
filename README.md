# ccweb

Claude Code 的流式 Web 工作台：对话（stream-json 双向管道）为全宽主角，目录树/编辑器是从标题栏左上（工作目录三件套）派生的一体化浮层（右键全功能文件管理、多 tab 编辑）。Rust 后端（axum/tokio 单二进制，前端全量嵌入）+ React 前端；npm 机制只用于 frontend/，根目录纯 shell 脚本（build.sh / deploy.sh）编排构建与部署。

> 2026-11-06 从 `keeper/deploy/ccweb` 拆出独立仓库；2026-11-07 后端移植 Rust（Node 版已移除，API/WS 契约经双后端逐字节 diff 验证后切换）。

## 目录结构

```
backend/            Rust 后端（cargo workspace 自持：Cargo.toml/lock、.cargo 镜像、target/ 都在这层）
  ccweb-core/       业务核心 lib：会话管道/fs API/历史回放/静态嵌入（Tauri 壳将来直接依赖）
  ccweb-server/     薄 bin：CLI 解析/bind/信号/启动横幅
frontend/           前端（React + TypeScript + Vite）——js/mjs 全部收在这层：依赖自持，测试也在这
  src/ChatPanel     对话区（chat-first 布局底层主角，头部即全局标题栏：cwd chip 开关目录树 / ▾ 历史工作目录 / 换目录）
  src/DirPicker     工作目录选择器（面包屑自由导航 + ✓ 确认；树锁死工作目录内，换目录唯一入口）
  src/Explorer      目录树浮层（标题栏下方垂到底；右键菜单、多选、拖放、上传/下载；独立 X 关闭）
  src/Editor        编辑器浮层（贴树右侧；tab 管理与编辑）
  test/             node 测试（playwright UI 冒烟 + 服务端 e2e/resume + esbuild/jsdom 组件测试；stubs/ 为 esbuild 别名桩）
build.sh            根目录唯一编排脚本（make/make install/make clean 语义）：构建出 ./ccweb；deploy（= install）装 /usr/local/ccweb + systemd；clean 清产物
restart.sh          本机快速迭代：构建 + 重启 18090 服务（nohup ./restart.sh &；活会话断开，刷新自动 resume）
```

npm 机制只存在于 frontend/ 内部（install/dev/build 走 vite）；cargo 一切在 backend/ 内；根目录无 package.json、无 Cargo 文件。

## 快速开始

```bash
(cd frontend && npm install)          # 前端依赖（Rust 侧经 backend/.cargo/config.toml 走 rsproxy 镜像）
./build.sh                            # 全量构建：frontend/dist + 根目录 ./ccweb（~19MB 单文件）
./build.sh clean                      # 清产物：./ccweb、frontend/dist、cargo target
CCWEB_NO_RUST=1 ./build.sh            # 只出前端（开发够用）

(cd backend && cargo run -p ccweb-server)   # Rust 后端开发跑（debug 态 dist 从磁盘读，前端重建无需重编）
(cd frontend && npm run dev)                # 前端开发（vite HMR）
```

### Windows 本地开发：GNU link.exe 冒充 MSVC 链接器的坑

前置：VS Build Tools（MSVC v142 + Windows 10 SDK）+ Rust `stable-x86_64-pc-windows-msvc`。

**坑**：Git Bash 环境下 `cargo build` 链接期报
`linking with link.exe failed` / `link: extra operand '....rcgu.o'` / `Try 'link --help'`——
这是 **GNU coreutils 的 `link`**（建硬链接的小工具，Git for Windows 装在
`C:\Program Files\Git\usr\bin\link.exe`，还有 `coreutils\bin` 变体）冒充了 MSVC 链接器：
rustc 按 PATH 找 `link.exe`，Git 的 usr/bin 抢在前面，它不认识链接器参数。真 MSVC
link.exe 在 VS Build Tools 里且**不在 PATH**（需 vcvars 激活），所以裸 cargo 必然中招。

**解法**：构建跑在 vcvars 环境里（同时就位真 link.exe 与 LIB/INCLUDE）：

```bat
call "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
cd /d <repo>\backend && cargo build -p ccweb-server
```

或固化为包装脚本（本机已放 `~/build-msvc.cmd`，用法 `build-msvc.cmd [--release -p ccweb-server]`）。

其余 Windows 适配已落码：build.sh 产物 `ccweb.exe` 后缀、qtom bash 工具探测 Git Bash 的
sh.exe、daemon（contrib/dsweb）Chrome 探测含 Windows 装位且不走 Xvfb。

正式部署 `./build.sh deploy`（见下）。

## 部署

按目标环境取用，三种形态同一份代码：

- **裸跑**：`(cd backend && cargo run)`——开发态（dist 读磁盘）
- **单文件**：根目录 `./ccweb`（./build.sh 产物，Rust 二进制 + 前端全量嵌入，~19MB；原 SEA 形态 137MB 的 1/7，常驻内存 ~8MB vs Node ~52MB；git 忽略）——拷到任何装了 claude 的机器，任意目录 `./ccweb` 即跑，无任何运行时依赖
- **./build.sh deploy**：假如使用 systemd 的话（Linux 服务器常态），构建+安装一条命令——开发目录只是源码，服务装在系统位置、与源码解耦，升级 = 重跑 `./build.sh deploy`：
  1. 全量构建出 Rust 单文件（Linux 目标需 linux 构建产物——目标机构建或交叉编译）
  2. 安装 **`/usr/local/ccweb`**（自包含单文件本体）
  3. 生成 systemd 单元（自适应 User/HOME/端口，默认 **18090**；`CCWEB_PORT=xxx ./build.sh deploy` 改端口）→ 安装重启 → 健康检查

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
./ccweb -p 18090                # 指定端口（--port=18090 等价）
./ccweb --home /data/ws --single
./ccweb --help                  # 完整用法；--version 查版本
```

启动横幅始终打印生效参数（含默认值），端口带来源标注：

```
[ccweb] v0.1.0  http://0.0.0.0:18090
       port: 18090 (-p)   home: /Users/huangbin
       claude: /usr/local/bin/claude   auth: nopass   single: off
```

优先级 **CLI > env > 默认**；无法识别的参数直接报错退出（exit 2）。

## 环境变量

systemd unit 传 env 比 args 方便，env 形态全量保留（与上表 CLI 一一对应）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCWEB_PORT` | 8090 | 监听端口 |
| `CCWEB_HOME` | `$HOME` | 工作区根（树根/会话 cwd 钳制边界） |
| `CCWEB_SINGLE` | – | `=1` 发布单会话形态：至多一个活会话，前端隐藏会话切换 |
| `CCWEB_CLAUDE` | PATH 探测 | claude 可执行文件路径覆盖 |
| `CCWEB_NO_RUST` | – | `=1` 时 ./build.sh 跳过 Rust 单文件打包 |

## 访问认证（code-server 同款语义）

```bash
./ccweb --auth=nopass                      # 默认：无认证
./ccweb --auth=password --password=xxx     # 密码模式
CCWEB_AUTH=password CCWEB_PASSWORD=xxx ./ccweb   # env 形态（systemd unit 传 env 更方便）
```

- 密码模式：全部 HTTP/WS 需会话 cookie；未登录页面 303 → `/login`（内建深色登录页），API 401，WS 拒绝
- 登录成功签发 30 天 `ccweb_auth` cookie（HttpOnly/SameSite=Lax）；`/logout` 登出销毁
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

## qtom 引擎：自带的免费 agent（DeepSeek 网页版）——已下线（2026-11-09）

> **下线说明**：DeepSeek 网页版账号因风控被禁言（疑似工具协议拼接 + 每请求新会话的行为特征），
> 通道停用。代码全部保留：`backend/qtom/`（crate 自洽，可 `cargo build --manifest-path qtom/Cargo.toml`
> 独立编译）、`contrib/dsweb/`（daemon）、ccweb 后端接入（spawn/审批/resume）与前端兼容分支；
> 已移出的部分：workspace 编译、build.sh 产物、UI 引擎入口。复活路径：账号可用后，把
> `backend/Cargo.toml` 的 members 加回 `qtom`、恢复 build.sh 两行、去掉 App.tsx 引擎过滤即可。

qtom 是内置的第二引擎——一只自研的 Rust 编码猫（qkeeper 动物园第一只居民），与 claude CLI
同等地被 spawn（stdio 说同款 stream-json 协议），模型通道走 **DeepSeek 网页版（免费）**：
本机跑一个 dsweb daemon 用 CDP 驱动真浏览器，工具调用经实测的文本协议桥
（`<tool_call>{"name":..,"arguments":..}</tool_call>`）翻译成标准 OpenAI tool_calls。
装 ccweb 白送一个免费 agent，零额外安装。

### 部署（三步）

```bash
# 1. 起 daemon（唯一依赖 node + ws；macOS 直接弹有头 Chrome，Linux 需 xvfb）
cd contrib/dsweb && npm install
PORT=8300 DSWEB_TOKEN=某随机串 node daemon.js
#    → 弹出的浏览器里登录一次 DeepSeek（登录态持久在 ~/.dsweb/profile，之后免登）
#    服务器长跑可 DSWEB_HEADLESS=1 无头（复用已登录 profile；登录本身需有头一次）

# 2. ccweb 挂上端点（daemon 与 ccweb 同机）
./ccweb --dsweb http://127.0.0.1:8300 --dsweb-token 某随机串   # 或 CCWEB_DSWEB_URL/CCWEB_DSWEB_TOKEN

# 3. UI 底部工具栏出现「引擎」切换（🐱 qtom / Claude），切到 qtom 后「新会话」即免费 agent
```

也可终端直用：`qtom --dsweb-url http://127.0.0.1:8300 --dsweb-token t -p "看看这个目录" --yes`。

### 行为与边界

- 工具六件套：read_file / write_file / edit / bash / glob / grep（bash 走授权卡片，
  文件工具不问——v1 固定策略）；路径限制在会话目录内
- 会话恢复/历史列表/审批卡/流式渲染与 claude 引擎完全同体验（transcript 写同款
  JSONL 格式，历史面板可回放、可 resume）
- 单模型 deepseek-web（无模型切换）；无图片输入；usage 为估算；上下文窗口按 64k 计
- daemon 靠 DeepSeek 网页 DOM（`.ds-message` 选择器）工作——网页改版需更新 daemon.js；
  每请求开新会话（全量拼接），打断无害
- qtom 二进制随 build.sh 一起产出（./qtom），部署时装在 ccweb 同目录；`CCWEB_QTOM` 可显式指路

## 测试

```bash
node frontend/test/e2e-test.mjs http://127.0.0.1:18090/     # 端到端冒烟：入口→会话→WS→claude 回复（需 claude 可用）
node frontend/test/resume-test.mjs <base> <sid> <cwd>       # resume 幂等/续聊验证
node frontend/test/dsweb-stub.mjs &                         # dsweb 桩（8312，无需 DeepSeek）
node frontend/test/qtom-e2e.mjs http://127.0.0.1:18099/     # qtom 引擎全链路：创建→流式→工具→审批→resume（ccweb 需 --dsweb 指桩）
cd frontend && node test/multi-select-test.mjs              # playwright UI 冒烟（多选/拖放/跟随等）
```
