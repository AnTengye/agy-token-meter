---
name: token-meter
description: 查看当前会话 Token 消耗、Prompt 缓存命中率、Swarm / Teamwork 会话树汇总以及今日/近24小时全局统计；在合适时弹出侧边栏面板链接或执行离线诊断。
---

# Token Meter

`token-meter` 是轻量级原生 Sidecar UI 插件，通过只读解析本地会话 SQLite（`steps.metadata`）统计实时 Token 消耗与缓存命中率，不向对话上下文注入任何额外文本（零 Token 开销）。

## 1. 打开侧边栏面板

若插件已启用且 sidecar 处于运行状态，可在回复中附上以下链接（点击在右侧 Aux Pane 打开或切换面板）：

```markdown
[Token Meter](sidecar://token-meter/meter/)
```

> 若侧边栏未激活或插件未开启，引导用户在 [Token Meter](customization://token-meter) 页面启用插件。

## 2. 离线 CLI 诊断与健康检查

可直接对指定会话或全局窗口运行单次统计（不启动 HTTP 服务），支持跨平台 Node 入口：

```bash
node ~/.gemini/config/plugins/token-meter/install.mjs doctor
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --inspect <conversationId>
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --overview today
node ~/.gemini/config/plugins/token-meter/sidecars/meter/main.mjs --overview 24h
```
