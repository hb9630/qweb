# ccweb

Claude Code 的流式 Web 工作台：对话（stream-json 双向管道）+ 文件树（右键全功能文件管理）+ 编辑器 + 终端。Rust 后端（axum/tokio 单二进制，前端全量嵌入）+ React 前端，frontend `npm install` + `npm run build` 即出可分发单文件。

> 2026-11-06 从 `keeper/deploy/ccweb` 拆出独立仓库；2026-11-07 后端移植 Rust（Node 版已移除，API/WS 契约经双后端逐字节 diff 验证后切换）。

## 目录结构

```
crates/             Rust 后端（cargo workspace）
  ccweb-core/       业务核心 lib：会话管道/fs API/历史回放/静态嵌入（Tauri 壳将来直接依赖）
  ccweb-server/     薄 bin：bind/信号/启动日志
frontend/           前端（React + TypeScript + Vite，依赖自持——node_modules 在 frontend/ 内）
  src/Explorer      左栏文件树（右键菜单、多选、拖放、上传/下载）
  src/ChatPanel     对话区（流式渲染、ctx 窗口、会话切换）
  src/Editor        代码/文本编辑器
  *-test.mjs        playwright UI 冒烟（node xxx-test.mjs，默认连 18090）
scripts/            构建与部署
  build.mjs         npm run build：前端 → Rust 单文件（build/ccweb）
  build-rust.mjs    cargo release 构建 → build/ccweb
  deploy.mjs        npm run deploy：组装 /usr/local/ccweb 安装树 + systemd
  ccweb.service     systemd 单元模板（deploy.mjs 的输入）
test/               服务端测试：e2e-test.mjs / resume-test.mjs
build/              构建产物（git 忽略）：ccweb 单文件（~19MB）
```

## 快速开始

```bash
cd frontend && npm install   # 前端依赖（独立安装；Rust 侧经 .cargo/config.toml 走 rsproxy 镜像）
npm run build          # 全量构建：frontend/dist + build/ccweb（Rust 单文件，~19MB）
CCWEB_NO_RUST=1 npm run build   # 只出前端（开发够用）

cargo run -p ccweb-server      # Rust 后端开发跑（debug 态 dist 从磁盘读，前端重建无需重编）
npm run dev                    # 前端开发（vite HMR）

npm run deploy         # 正式部署（见下）
```

## 部署

按目标环境取用，三种形态同一份代码：

- **裸跑**：`cargo run` / `target/release/ccweb-server`——开发态（dist 读磁盘）
- **单文件**：`build/ccweb`（Rust 二进制 + 前端全量嵌入，~19MB；原 SEA 形态 137MB 的 1/7，常驻内存 ~8MB vs Node ~52MB）——拷到任何装了 claude 的机器，任意目录 `./ccweb` 即跑，无任何运行时依赖
- **npm run deploy**：假如使用 systemd 的话（Linux 服务器常态），一条命令完成正式安装——开发目录只是源码，服务装在系统位置、与源码解耦，升级 = `npm run build && npm run deploy`：
  1. 安装 **`/usr/local/ccweb/ccweb`**（自包含单文件；Linux 目标需 linux 构建产物）
  2. 生成 systemd 单元（自适应 User/HOME/端口，默认 **18090**；`CCWEB_PORT=xxx npm run deploy` 改端口）→ 安装重启
  3. 健康检查通过后输出上线确认

## 与 Node 版的刻意差异（Rust 版）

1. 畸形请求（`//` 开头路径、非法 `%` 转义）→ 400（Node 曾挂死连接）
2. 目录下载内建 tar+flate2（不依赖系统 tar 二进制；客户端中断即刻停止打包）
3. claude spawn 失败 → 广播 `{t:"exit",code:null}` + 迟到订阅者补发 exit 帧（Node 挂死不回）
4. body 超限/中断 → 413/400（Node 吊连接不回包）
5. 未知 `/ws/{id}` 升级 → 404（Node 裸断 socket）
6. `PUT /api/fs/file` 的 `size` = JS UTF-16 码元数（与 Node `.length` 对齐；GET 的 `size` 为字节数——继承 Node 原有不一致）
7. files 排序 localeCompare → 大小写不敏感字节比较（ASCII 序一致）；`/api/history` 分组顺序随文件系统枚举序（Node 同样非确定，前端按 cwd 过滤不依赖组序）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CCWEB_PORT` | 8090 | 监听端口 |
| `CCWEB_HOME` | `$HOME` | 工作区根（树根/会话 cwd 钳制边界） |
| `CCWEB_SINGLE` | – | `=1` 发布单会话形态：至多一个活会话，前端隐藏会话切换 |
| `CCWEB_CLAUDE` | PATH 探测 | claude 可执行文件路径覆盖 |
| `CCWEB_NO_RUST` | – | `=1` 时 npm run build 跳过 Rust 单文件打包 |

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
  control_request 到达前端渲染成琥珀色授权卡片（工具名 + 入参 + 允许/拒绝）；决定经
  `{"t":"perm","rid":..., "allow":...}` 回写 stdin，deny 文案会作为 tool_result 反馈给模型。
  询问帧入回放缓冲——刷新页面后未决卡片自动恢复。allow 回包按协议带原 input 作
  `updatedInput`（2.1.212 逐字实测的 wire 格式）。
- **图片**：输入框粘贴 / 拖拽 / 回形针按钮三种入口（≤4MB/张），走 stdin
  `source.base64` content block（`data+media_type`/`mimeType` 形态 CLI 均拒收），
  用户气泡带 📎 徽章，历史回放同样可见。
- **插话（steering）**：回复进行中发送的消息**不进消息流**——钉在输入框上方的
  排队条里（可 ✕ 删除、可 ↑ 立即送出），本轮 `result` 到达时整队自动送出上屏，
  与 CLI 轮末送达的时机一致。
- 渲染：子代理事件（`parent_tool_use_id` 非空）缩进弱化；思考 token 增量计数
  （"思考中… ~N tokens"）；MCP 工具名 `mcp__srv__tool` 美化为 `mcp:srv/tool`。

## 测试

```bash
npm test                                   # 端到端冒烟：入口→会话→WS→claude 回复（需 claude 可用）
node test/resume-test.mjs <base> <sid> <cwd>   # resume 幂等/续聊验证
cd frontend && node multi-select-test.mjs  # playwright UI 冒烟（多选/拖放/跟随等）
```
