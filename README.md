# AGY Token Meter

专为 **Google Antigravity 2.0 桌面客户端（AGY App）** 打造的原生、零外部依赖、零额外 Token 消耗的实时 Token 消耗与 Prompt 缓存命中率监控插件（Aux Pane Sidecar UI）。

直接以只读方式解析本地 SQLite 会话数据库（`steps.metadata`），在右侧辅助面板实时显示当前会话消耗、Prompt 缓存效率、**Swarm / Teamwork** 多代理会话树聚合统计，以及按需加载的**今日 / 近 24 小时**全量消耗看板。

---

## 核心特性

- **当前会话实时监控**
  - 展示总 Token、缓存命中率进度条、最新上下文窗口大小、输入拆分（未命中缓存 / 缓存读取）、输出拆分（思考 / 可见文本）及调用/压缩次数。
  - **逐轮缓存条形图**：展示最近 30 轮调用的上下文体积与缓存命中比例，对非首轮出现 `cache_read = 0`（缓存失效）与 `step_type = 23`（上下文压缩）自动标注警示。
- **Swarm 与 Teamwork 多代理会话树汇总**
  - 自动结合 `conversation_summaries.db`、`conversation_parents` 与 `brain/<rootId>/.system_generated/swarm/members.json` 向上回溯根节点。
  - 在任意子代理 / Worker / Orchestrator 窗口打开面板时，自动识别 `Swarm`、`Teamwork` 或 `子代理` 模式，并列对比**当前节点**与**整组全树**的总消耗与综合命中率。
  - 提供按嵌套深度统计、整组模型分布以及成员消耗排行榜；**点击成员条目可直接跳转切换至对应会话**（大树自动折叠低消耗历史节点，仅返回活跃与 Top 40 成员以防载荷膨胀）。
- **按需全局总览（今日 / 近 24 小时）**
  - 仅在切换至「总览」Tab 或手动刷新时计算（后台**零轮询**），按步骤时间戳精确截断跨日会话，并按根会话树聚合排行。
- **原生主题与极简交互**
  - 通过 `preload.js` 自动同步宿主深色 / 浅色主题变量，零外部字体或 CDN 请求，适配右侧窄列面板。

---

## 轻量架构与性能设计

本插件不依赖任何第三方 npm 包，仅使用 Antigravity 2.0 内置运行时自带的 **`node:sqlite`**（Node `>= 22.5` / 内置 Electron Helper `v24.22.0`）与 **`sidecar_sdk`**。

| 设计维度 | 实现机制 | 实测开销 |
| :--- | :--- | :--- |
| **Token / 缓存零污染** | 纯本地读盘展示；**不注册**任何注入对话上下文的 Hook | 额外 Token 消耗 **= 0** |
| **增量 SQLite 读取** | 仅查询 `steps` 表的 `idx, step_type, metadata WHERE idx > lastIdx`，跳过 `step_payload` 大字段 | 单会话增量读取 **< 1 ms** |
| **签名与 ETag 缓存** | 先 `stat` 校验 `.db` 与 `.db-wal` 的 `mtime + size`；文件未变直接命中内存 LRU 缓存（上限 600 会话）并回 `{ unchanged: true }` | 356 节点大树热轮询约 **2 ms** |
| **只读无锁防阻塞** | 使用 `{ readOnly: true, timeout: 1000 }` 打开后立即在 `finally` 中 `close()`，不阻塞客户端 WAL checkpoint | 不影响主对话并发写入 |
| **可见性感知轮询** | `document.visibilityState === 'hidden'` 时彻底暂停 2.5s 定时器，切回前景再唤醒 | 面板隐藏时 CPU **≈ 0%** |

### 数据计算口径

插件直接读取 `steps.metadata` 中 `field 9`（`ModelUsage`）及 `field 1`（`Timestamp`），与服务端计费统计保持一致：

- `总输入 Token = 未命中缓存输入 (field 2) + 缓存读取 (field 5)`
- `总输出 Token = 输出 (field 3)`（其中 Gemini 含 `field 9` 思考 Token + `field 10` 可见输出 Token）
- `总消耗 Token = 总输入 Token + 总输出 Token`
- `缓存命中率 = 缓存读取 / 总输入 Token × 100%`

---

## 快速安装（人工使用）

### 方式一：一键脚本安装（推荐，自动完成校验与原子替换）

```bash
curl -fsSL https://raw.githubusercontent.com/AnTengye/agy-token-meter/main/install.sh | bash
```

### 方式二：克隆仓库后本地安装（支持软链开发模式）

```bash
git clone https://github.com/AnTengye/agy-token-meter.git
cd agy-token-meter
./install.sh          # 原子拷贝安装到 ~/.gemini/config/plugins/token-meter
# 或开发调试使用软链：
# ./install.sh install --link
```

### 方式三：极简直接克隆安装

```bash
git clone https://github.com/AnTengye/agy-token-meter.git ~/.gemini/config/plugins/token-meter
```

### 启用与打开方式

1. 安装到 `~/.gemini/config/plugins/token-meter` 后，Antigravity 2.0 会自动热加载插件，**无需重启客户端，也无需手动编辑 `~/.gemini/config/config.json`**。
2. 在 Antigravity 左侧栏 **Skills & Customizations → Plugins → Token Meter** 可随时开关插件。
3. 在任意会话窗口右侧 Aux Pane 的 `+` 菜单中选择 **Token Meter**（或在对话中点击 Agent 输出的 `[Token Meter](sidecar://token-meter/meter/)` 链接）即可打开实时面板。

---

## AI Agent 自主安装方案

如果你希望让 Antigravity、Codex 或 Claude Code 等 AI Agent 自动完成安装、体检并为你打开面板，可直接使用以下方案。

### 1. 直接复制给 AI Agent 的提示词

```text
请帮我安装并启用开源 Antigravity 插件 agy-token-meter（https://github.com/AnTengye/agy-token-meter）：
1. 先检查 ~/.gemini/config/plugins/token-meter 是否已存在避免冲突；
2. 执行 `curl -fsSL https://raw.githubusercontent.com/AnTengye/agy-token-meter/main/install.sh | bash` 完成原子安装；
3. 严禁手动修改 ~/.gemini/config/config.json 或调用受限写状态 RPC；
4. 运行 `bash ~/.gemini/config/plugins/token-meter/install.sh doctor` 验证引擎只读测试与 Sidecar 状态；
5. 最后提供 [Token Meter](customization://token-meter) 与（当 Sidecar 已监听时）[Token Meter](sidecar://token-meter/meter/) 链接。
```

### 2. AI Agent 标准化执行规约（供 Agent 自读）

```markdown
1. 目标与前置检查：
   - 目标安装路径：`~/.gemini/config/plugins/token-meter`（可通过环境变量 `AGY_PLUGIN_DIR` 覆盖）。
   - 检查是否已存在同名插件或冲突；若已存在，询问用户或直接覆盖更新同一插件目录。
2. 执行幂等安装：
   - 运行：`curl -fsSL https://raw.githubusercontent.com/AnTengye/agy-token-meter/main/install.sh | bash`
   - 若网络无法直连 GitHub Raw，可改用：`git clone --depth 1 https://github.com/AnTengye/agy-token-meter.git /tmp/agy-token-meter && bash /tmp/agy-token-meter/install.sh && rm -rf /tmp/agy-token-meter`
3. 强制安全护栏：
   - 禁止手工读写或覆盖 `~/.gemini/config/config.json`。
   - 禁止调用 `JetboxWriteState` / `InstallCustomization` / `DeletePlugin` 等受限 RPC。
   - 禁止将该插件配置为对话 Hook，保持纯只读 Sidecar 形态。
4. 自检与验收：
   - 执行 `bash ~/.gemini/config/plugins/token-meter/install.sh doctor`，确认以下项均通过：
     a) 必需文件完整（`plugin.json`, `sidecars/meter/{sidecar.json,engine.mjs,main.mjs,index.html,styles.css,app.js}`）；
     b) `node:sqlite` 只读烟雾测试成功（`--overview today`）；
     c) 如插件已激活，验证 `~/.gemini/antigravity/sidecar_data/token-meter/meter/logs/sidecar.log` 中的本地端口可响应 `GET /`。
   - 若本机启用了 `GetAllPlugins` RPC，可执行校验确认 `name: "token-meter"` 且 `disabled: false`。
5. 结果交付：
   - 向用户输出管理页链接：`[Token Meter](customization://token-meter)`
   - 若确认 Sidecar 已运行，附上侧边栏直达链接：`[Token Meter](sidecar://token-meter/meter/)`
```

---

## 离线诊断、运维与卸载

安装后可通过安装脚本或 Node CLI 直接执行离线检查（只读，不修改任何会话库）：

```bash
# 健康检查（文件完整性、node:sqlite 兼容性、引擎只读测试、Sidecar 端口检测）
bash ~/.gemini/config/plugins/token-meter/install.sh doctor

# 检查指定会话（含 Swarm / Teamwork 全树汇总与冷/热缓存耗时）
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --inspect <conversationId>

# 统计今日或近 24 小时所有会话汇总
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --overview today
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --overview 24h

# 卸载插件
bash ~/.gemini/config/plugins/token-meter/install.sh uninstall
```

> 若系统全局未安装 Node `>= 22.5`，在 macOS 上可直接用 Antigravity 内置运行时执行上述命令：
> `ELECTRON_RUN_AS_NODE=1 "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper" ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --overview today`

---

## 仓库目录结构

```text
agy-token-meter/
├── plugin.json                 # Antigravity 2.0 插件清单
├── install.sh                  # 一键安装 / 卸载 / 体检脚本
├── LICENSE                     # MIT 开源协议
├── README.md
├── assets/
│   └── logo.svg                # 插件矢量图标
├── skills/
│   └── token-meter/
│       └── SKILL.md            # Agent 技能指引（打开面板与离线诊断）
└── sidecars/
    └── meter/
        ├── package.json
        ├── sidecar.json        # AUX_PANE Sidecar 入口声明
        ├── engine.mjs          # 零依赖增量 Protobuf/SQLite 统计引擎
        ├── main.mjs            # Sidecar HTTP 服务与 CLI 自检入口
        ├── index.html          # 自适应侧边栏前端结构
        ├── styles.css          # 宿主深浅主题自适应样式
        └── app.js              # ETag 增量轮询与可视交互逻辑
```

---

## 隐私与安全

- **100% 本地只读**：仅读取本地 `~/.gemini/antigravity/` 下的会话数据库与 `members.json` 索引，不修改任何会话数据。
- **零遥测与零外网请求**：插件服务端与前端均不发起任何外部网络请求、不上报任何用户数据或 Token 明细。

---

## License

[MIT](./LICENSE)
