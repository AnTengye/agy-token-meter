---
name: token-meter
description: 查看当前会话 Token 消耗、Prompt 缓存命中率、Swarm / Teamwork 会话树汇总以及今日/近24小时全局统计；仅在用户明确要求查看消耗或打开面板时才输出 sidecar:// 链接，或执行离线 CLI 诊断。
---

# Token Meter

`token-meter` 是轻量级原生 Sidecar UI 插件，通过只读解析本地会话 SQLite（`steps.metadata`）统计实时 Token 消耗与缓存命中率，不向对话上下文注入任何额外文本（零 Token 开销）。

## 1. 打开侧边栏面板（v2.35.1+ 自动弹板约束）

> [!IMPORTANT]
> Antigravity v2.35.1 起，**只要回复中出现 `sidecar://` 链接就会自动打开/切换右侧 Aux Pane**。
> - **仅当用户明确要求**查看当前 Token 消耗、缓存命中率、统计总览或打开 Token Meter 面板时，才在回复中输出下方的 `sidecar://` 链接。
> - **日常对话顺口提及**插件名、配置变更或无关排障时，**严禁输出** `sidecar://token-meter/meter/` 链接（可纯文本提及 `token-meter`），避免误弹右侧面板打断用户。

满足上述触发条件且插件已启用、sidecar 处于运行状态时，在回复中附上：

```markdown
[Token Meter](sidecar://token-meter/meter/)
```

> 若侧边栏未激活或插件未开启，仅在用户需要启用或排查插件状态时引导前往 [Token Meter](customization://token-meter) 页面开启。

## 2. 离线 CLI 诊断与健康检查

可直接对指定会话或全局窗口运行单次统计（不启动 HTTP 服务），支持跨平台 Node 入口：

```bash
node ~/.gemini/config/plugins/token-meter/install.mjs doctor
node ~/.gemini/config/plugins/token-meter/install.mjs doctor --check-update
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --check-update
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --inspect <conversationId>
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --overview today
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --overview 24h
```
