# Sotto Voce

Sotto Voce 是一个面向私人使用的 AI 聊天与生活记录 PWA。它把聊天、每日手记、伴读批注、记忆检索、模型配置、MCP 工具调用和用量统计放在同一个小型应用里，适合部署在自己的服务器上，通过手机浏览器或“添加到主屏幕”的方式使用。

这个项目不是通用聊天平台，也不是多人协作系统。它更像一个自己掌控数据和模型配置的私人 AI 空间：前端尽量像移动端 App，后端负责保存聊天、调用 LLM、连接 MCP 工具、管理本地 SQLite 数据。

## 项目介绍

- **项目名称**：Sotto Voce
- **解决的问题**：把私人 AI 对话、日常待办/打卡、伴读批注和长期记忆组织到一个可自部署的 Web App 中，避免聊天记录、模型配置和个人数据分散在多个工具里。
- **核心理念**：本地数据库保存个人数据；模型、MCP 服务器、提示词和主题都可以在应用内配置；前端以手机 PWA 为主要体验。
- **适合用户**：
  - 想自部署私人 AI 聊天应用的人；
  - 需要保留长期聊天记录、日常手记和伴读记录的人；
  - 想把外部 MCP 工具接入聊天流程的人；
  - 能接受自己配置 API Key、服务器环境和访问令牌的个人用户。

## 功能特点

### 私人聊天

- 支持多会话管理：新建、重命名、删除、切换对话。
- 支持流式 AI 回复，前端通过 SSE 接收内容。
- 支持消息编辑并重新生成：编辑用户消息后，会删除该消息之后的回复并重新请求 AI。
- 支持重新生成、复制、收藏、删除消息。
- 支持图片和常见文件附件上传。
- 图片附件会作为视觉输入发送给支持多模态的上游模型；非图片附件以文本占位形式进入上下文。
- 支持日期分隔符、长按菜单、图片预览、跨对话关键词搜索、图片/文件搜索和日期搜索。

### LLM 配置与用量统计

- 支持在设置页配置多个模型预设。
- 支持 Anthropic 格式和 OpenAI 兼容格式接口。
- 支持从上游拉取模型列表，并在前端选择模型。
- 记录每轮对话的输入 token、输出 token、cache read/write token 和费用。
- 如果上游 usage 中返回 `cost` 字段，会优先使用上游给出的真实费用；否则按预设价格估算。
- 支持 prompt cache 相关 token 的记录与展示。

### MCP 工具接入

- 支持配置 MCP Streamable HTTP 服务器。
- 后端会从已启用的 MCP 服务器拉取工具列表，并提供给 LLM 调用。
- 内置 `terminal_exec` 工具，允许 LLM 在服务器上执行命令。
- 设置页也提供手动终端页面，可执行命令并查看最近历史。
- 默认会写入一个 Ombre Brain MCP 服务器配置，用于记忆相关功能。

### 记忆页面

- 通过 MCP 工具读取记忆桶、对话归档和情绪趋势。
- 支持记忆桶列表、详情查看、归档列表和基础筛选。
- 前端会使用 localStorage 缓存部分记忆数据，减少打开页面时的等待感。

### 首页

- 展示问候语、在一起天数、纪念日倒计时、最近对话摘要、今日回忆和今日待办。
- 最近对话摘要由后端异步生成并缓存；首页接口不会因为摘要生成而长时间阻塞。
- 今日待办来自手记日历里的当天未完成待办。

### 手记日历

- 月历视图展示打卡、待办、里程碑和纪念日。
- 支持每日打卡和连续天数统计。
- 支持新增待办、勾选待办完成、添加里程碑。
- 首页会同步显示当天未完成待办。

### 伴读

- 支持上传 `.txt` 书籍。
- 后端会将书籍按段落保存到数据库。
- 阅读页以连续滚动方式显示全文，并记录阅读进度百分比。
- 支持对段落添加用户批注。
- 支持让 AI 根据段落原文和用户批注生成简短回复，并保存为伴读批注。
- 支持查看批注列表和目录跳转。

### 数据导出

- 后端提供 `/api/export`，支持导出聊天记录和伴读批注。
- 前端设置页提供“导出数据”入口，当前固定导出全部聊天记录和伴读内容为 Markdown。
- 导出内容会按对话、书籍和时间组织。

### 上传与 PWA

- 上传接口限制文件类型：图片和常见文档（pdf、txt、md、docx、xlsx）。
- `/uploads/` 使用签名 URL 或 Bearer token 访问，避免直接公开上传文件。
- 提供 `manifest.json`、图标和 `sw.js`，支持作为 PWA 使用。
- Service Worker 对静态资源做缓存优先和后台刷新，避免网络抖动时 PWA 冷启动卡住。

## 项目架构

项目是一个单体应用：

```text
浏览器 / PWA
  ├─ index.html
  ├─ js/*.js        前端路由、状态、页面渲染、API 调用
  ├─ css/*.css      主题、聊天、手记、记忆、设置等样式
  └─ sw.js          PWA 静态资源缓存

Flask 后端
  ├─ app.py         HTTP API、上传、导出、终端、首页、书籍、记忆代理
  ├─ llm.py         LLM 请求组装、流式解析、工具调用循环、用量记录
  ├─ mcp_client.py  MCP Streamable HTTP 客户端、工具列表、记忆工具封装
  └─ db.py          SQLite 连接、schema 初始化、迁移字段、通用工具

SQLite 数据库
  └─ data/cheng.db  聊天、消息、设置、MCP、手记、书籍、批注、用量等数据

外部服务
  ├─ Anthropic 或 OpenAI 兼容 LLM API
  └─ MCP 服务器（默认配置包含 Ombre Brain）
```

前端不使用构建工具。`index.html` 直接加载 `js/router.js` 作为 ES module，其他模块通过相对 import 载入。后端和前端通常同源部署。

## 技术栈

### 编程语言

- Python
- JavaScript
- HTML
- CSS

### 后端

- Flask
- Gunicorn
- httpx
- requests
- flask-cors

### 数据库

- SQLite
- WAL 模式
- `busy_timeout = 5000`
- `foreign_keys = ON`

### 前端

- 原生 ES Modules
- 原生 Fetch API
- Server-Sent Events 解析
- localStorage 缓存
- PWA Manifest
- Service Worker

### AI / LLM

- Anthropic Messages 格式
- OpenAI 兼容 Chat Completions 格式
- OpenRouter 等 OpenAI 兼容上游
- Prompt cache / cache token 记录
- 多模态图片附件发送
- MCP 工具调用循环

### MCP

- MCP Streamable HTTP
- `tools/list`
- `tools/call`
- 内置 `terminal_exec`
- Ombre Brain 相关记忆读取封装

## 安装与运行

### 环境要求

- Python 3.10+（代码未强制指定版本，建议使用较新的 Python 3）
- 可访问 LLM API 的网络环境
- 一个可用的 LLM API Key
- 如果使用记忆功能，需要可访问的 MCP 服务器

### 1. 克隆项目

```bash
git clone https://github.com/ALLFORTING/sotto-voce.git
cd sotto-voce
```

### 2. 创建虚拟环境并安装依赖

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 3. 配置环境变量

最少需要配置：

```bash
export CHENG_API_TOKEN="your-strong-token"
```

可选：

```bash
export CHENG_CORS_ORIGINS="https://your-domain.example"
export UPLOAD_SIGNING_SECRET="your-upload-signing-secret"
```

如果没有设置 `UPLOAD_SIGNING_SECRET`，应用会自动生成一个随机 secret，并持久化到 `data/upload_signing_secret`。

### 4. 启动开发服务

```bash
python app.py
```

默认监听：

```text
http://127.0.0.1:5000
```

### 5. 生产运行示例

```bash
gunicorn -w 2 -b 127.0.0.1:5000 app:app
```

生产环境通常还需要 Nginx 或 Caddy 做 HTTPS 反向代理，并把站点和后端部署在同源域名下。代码中没有包含完整的 Nginx 配置文件。

## 配置说明

### 环境变量

| 变量 | 是否必需 | 作用 |
| --- | --- | --- |
| `CHENG_API_TOKEN` | 必需 | 前端访问 `/api/` 时使用的 Bearer token。没有正确 token，后端会返回 401。 |
| `CHENG_CORS_ORIGINS` | 可选 | CORS 允许来源，默认是 `https://allfortingting.xyz`。多个来源用逗号分隔。 |
| `UPLOAD_SIGNING_SECRET` | 可选 | 上传文件签名 URL 使用的 HMAC secret。未设置时会自动生成并保存到 `data/upload_signing_secret`。 |

### 访问令牌

前端会把访问令牌保存在 localStorage 的 `cheng_api_token` 中，并在请求 API 时发送：

```http
Authorization: Bearer <CHENG_API_TOKEN>
```

第一次打开应用时，需要在前端输入这个令牌。

### 数据库

数据库路径由代码固定为：

```text
data/cheng.db
```

首次启动时，`db.py` 会自动创建表和部分默认配置。项目没有使用外部数据库配置。

### 上传目录

上传文件保存到：

```text
../frontend/uploads
```

这个路径由 `app.py` 和 `llm.py` 里的 `UPLOAD_DIR` 共同使用。部署时需要确认后端进程对该目录有写入权限。

### 书籍目录

上传的 `.txt` 书籍保存到：

```text
data/books
```

### LLM 配置

LLM API Key 不通过环境变量配置，而是在应用设置页的“模型与接口”里配置，并写入 `api_presets` 表。

每个预设包含：

- 名称
- endpoint
- API key
- model
- format：`anthropic` 或 `openai`
- input_price
- output_price
- 是否启用

`GET /api/presets` 会对 API key 打码返回；只有在前端明确提交新的非空 API key 时，后端才会覆盖旧 key。

### MCP 配置

MCP 服务器保存在 `mcp_servers` 表里，可在设置页管理。字段包括：

- name
- url
- auth
- enabled

默认初始化会写入一个 Ombre Brain MCP 服务器地址。启用的 MCP 服务器会参与：

- LLM 工具调用；
- 记忆桶、归档、情绪趋势等记忆页面数据读取。

## 使用方法

### 1. 登录

打开应用后输入服务器配置的 `CHENG_API_TOKEN`。令牌会保存在浏览器 localStorage。

### 2. 配置模型

进入设置页：

1. 打开“模型与接口”。
2. 新增或编辑预设。
3. 填写 endpoint、API key、模型、请求格式和价格。
4. 保存并启用需要使用的预设。

没有启用的模型预设时，聊天接口会返回错误。

### 3. 聊天

进入聊天页：

- 输入文本发送消息。
- 可以上传图片或文件。
- 长按消息可以复制、编辑、重新生成、收藏或删除。
- 使用搜索页可以跨对话搜索关键词、图片、文件和日期。

### 4. 手记

进入手记页：

- 在日历里查看每天的打卡、待办、里程碑。
- 可以新增待办或里程碑。
- 勾选待办完成后，首页“今日待办”会同步更新。

### 5. 伴读

进入“伴读”：

1. 上传 `.txt` 书籍。
2. 打开书籍阅读。
3. 长按段落添加批注。
4. 可以请求 AI 对某段批注做简短回应。
5. 阅读进度按滚动百分比保存。

### 6. 记忆

进入记忆页：

- 查看记忆桶；
- 查看记忆桶详情；
- 查看对话归档；
- 查看情绪趋势。

这些数据来自已配置并启用的 MCP 服务器。

### 7. 导出

设置页提供“导出数据”入口。当前前端固定导出：

- 全部聊天记录；
- 全部伴读批注；
- Markdown 格式。

后端 `/api/export` 也支持更多参数组合。

## 项目结构

```text
.
├── app.py                         # Flask API：聊天、上传、搜索、手记、伴读、记忆、导出、设置等
├── db.py                          # SQLite schema、连接、初始化和迁移字段
├── llm.py                         # LLM 上下文组装、流式解析、工具调用、usage/cost 记录
├── mcp_client.py                  # MCP Streamable HTTP 客户端、工具调用、记忆数据封装
├── requirements.txt               # Python 依赖
├── index.html                     # PWA 入口页面
├── manifest.json                  # PWA manifest
├── sw.js                          # Service Worker 静态资源缓存
├── css/
│   ├── tokens.css                 # 主题变量和字体
│   ├── phone.css                  # 移动端整体布局
│   ├── chat.css                   # 聊天页样式
│   ├── journal.css                # 手记/伴读/账本相关样式
│   ├── memory.css                 # 记忆页样式
│   ├── settings.css               # 设置页和终端页样式
│   └── overlays.css               # 弹窗、浮层、长按菜单等样式
├── js/
│   ├── api.js                     # API 请求、上传、导出、SSE 流读取
│   ├── store.js                   # 前端全局状态、主题、localStorage 缓存
│   ├── router.js                  # 前端路由、事件处理、页面加载逻辑
│   ├── components.js              # 通用图标、布局和格式化工具
│   ├── home.js                    # 首页渲染
│   ├── chat.js                    # 聊天页、气泡、思考链、长按菜单渲染
│   ├── journal.js                 # 手记、伴读、阅读页渲染
│   ├── memory.js                  # 记忆页渲染
│   └── settings.js                # 设置页、模型/MCP/纪念日/终端渲染
├── fonts/
│   └── CormorantGaramond-Regular.ttf
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── scripts/
│   └── cleanup_thinking_annotations.py # 清理伴读批注中残留 thinking 标签的一次性脚本
└── tests/
    └── test_short_completion.py   # short_completion 和图片附件内容块测试
```

运行后还会生成：

```text
data/
├── cheng.db
├── books/
├── upload_signing_secret
└── memory_buckets_cache.json
```

这些运行时数据不属于源码结构。

## 测试

当前项目包含一个 Python unittest 测试文件：

```bash
python -m unittest discover -s tests
```

测试覆盖：

- OpenAI 兼容非流式返回中 `<thinking>` / `<think>` 标签的清理；
- 图片附件是否被转换为 Anthropic / OpenAI 兼容的图片 content block。

前端目前没有自动化测试脚本。

## 开发说明

### 前端开发

- 不需要构建步骤。
- 修改 `js/` 或 `css/` 后，需要同步更新：
  - `js/store.js` 里的 `VERSION`
  - `sw.js` 里的 `VERSION`
  - `index.html` 中静态资源 query 参数
- Service Worker 会缓存静态资源。调试 PWA 缓存问题时，可以在浏览器 DevTools 的 Application 面板中查看 Service Worker 和 Cache Storage。

### 后端开发

- 新增 API 时，默认会被 `@app.before_request` 的 `/api/` Bearer token 校验保护。
- 数据库 schema 在 `db.py:init_db()` 中维护。
- 对已有表新增字段时，项目当前做法是在 `init_db()` 中用 `PRAGMA table_info` 检查后 `ALTER TABLE`。
- SQLite 已启用 WAL 和 busy timeout，但仍适合个人使用场景，不适合高并发多用户服务。

### LLM 开发

- 主要入口是 `llm.py:chat_events()`。
- `/api/chat`、`/api/chat/regenerate`、`/api/chat/edit` 都复用同一套流式处理逻辑。
- 工具调用流程在 `_run_chat_stream()` 中处理。
- 图片附件只会对最近若干条历史消息编码发送，较早图片会降级为文本占位，以控制请求体大小和成本。
- 成本记录在 `usage_logs` 表中。

### MCP 开发

- MCP 工具列表来自 `mcp_client.refresh_tools()`。
- LLM 可用工具来自 `mcp_client.get_tools()`。
- 新 MCP 服务器可通过设置页或 API 写入 `mcp_servers` 表。
- `terminal_exec` 是内置工具，不来自外部 MCP 服务器。

### 上传安全

- `/api/upload` 同时检查 MIME 类型和扩展名。
- HTML、SVG、JS、PHP、Shell 脚本、可执行文件等类型会被拒绝。
- `/uploads/` 访问需要签名 URL 或 Bearer token。
- 非图片上传文件会以 `Content-Disposition: attachment` 返回。

## 已知限制

- 这是个人应用，不包含多用户账号系统。
- 前端没有构建系统和自动化测试。
- 代码中部分默认文案在当前仓库编码显示下存在乱码痕迹，但运行逻辑不依赖 README 中的这些文案。
- 终端执行功能能力较强，部署时应确保 `CHENG_API_TOKEN` 足够安全，并限制服务暴露范围。
- 记忆功能依赖外部 MCP 服务器的工具名称和返回格式。

## License

当前仓库中没有发现 `LICENSE` 文件，因此 README 不声明具体开源许可证。
