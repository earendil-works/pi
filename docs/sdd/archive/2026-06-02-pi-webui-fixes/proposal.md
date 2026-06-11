# 变更提案: pi-webui-fixes (WebUI 真实使用问题修复)

## 动机

`pi-webui` 已在浏览器中真实使用(端口 18800,持续 56 分钟),暴露了 5 个直接影响可用性的问题:

1. **session 列表范围错** — WebUI 把 `process.cwd()` 解析成 webui 包目录(`packages/webui/`),所以只列 `~/.pi/agent/sessions/--home--qjh--workspace--personal--pi--packages--webui--/` 下的 12 个测试 session。用户在 `~/pi` 跑 pi 的真 session(`--home-qjh-pi--/`)完全看不到。
2. **agent 答非所问** — WebUI WS 调 pi 子进程时发了 `{type:"prompt", text, images}`,但 pi RPC 协议要的是 `{type:"prompt", message, ...}`。`message` 字段是 undefined,prompt 根本没进 LLM,只是流回来用户输入。1 行字段名 bug。
3. **DELETE 卡死** — 调 LLM 抽 atoms 等 5s×retry=10s,UI 一直转没反应。POST 没反馈。文件其实删了但用户以为没删。
4. **UI 布局反人类** — 现在的布局是 `Sessions` 独立页 + `Cron` 独立页,需翻路由才能看到 history。豆包/ChatGPT 风格是 session 列表常驻左栏、点开直接聊,会话名为第一句话。需要 UI 重构。
5. **cron 7 个假 job** — 是我之前手动测试时通过 API 建的,真 cron 调度没跑这些。混在 `~/.pi/agent/data/cron.json` 里污染数据。

5 个问题联合起来让 WebUI 当前不可用。修复要联动 server + client。

## 影响范围

- 修改 Capability: `webui` (整体可用性)、`webui.session-listing` (范围 + 标题来源)、`webui.chat` (WS 协议 + DELETE 异步)、`webui.layout` (左栏 + 主页)

## 非目标

- 不做 session 全文搜索、session 标签、session 分享
- 不做 Memory UI(Memory 页暂时不开)
- 不做 user auth / 多用户(loopback 假设)
- 不修之前 `[!]` 标记的 7 个浏览器场景(留给下个 change)
- 不重做 cron 表单/Cron 列表的视觉(只清数据)

## 验收标准

1. **cwd 正确** — 在 `~/pi` 跑 `pi --web` → `GET /api/sessions` 返回 `~/.pi/agent/sessions/--home-qjh-pi--/` 下的 sessions,12 个 webui 测试 session 不可见。
2. **agent echo 修复** — WebUI 输入"nihao" → assistant 流式回 "你好" 之类的真 LLM 响应,不是 "nihao"。
3. **DELETE 乐观** — 点删除 → session 在 200ms 内从左栏消失,后台 atoms 抽取失败也不阻塞 UI(后端日志能看到失败但不影响响应)。
4. **POST 反馈** — 点 New Chat → 200ms 内新 session 出现在左栏顶部,且高亮选中。
5. **session 标题 = 首句** — 发送第一条消息后,左栏对应卡片标题立刻更新为该消息的前 30 字(空消息除外)。
6. **左栏会话列表** — 主路由 `/` 是空 chat 状态;`/session/:id` 打开 session;`/cron` 是 cron 页(从顶栏按钮进)。左栏常驻显示当前 cwd 的 session 列表,标题为首句。
7. **cron 清零** — `~/.pi/agent/data/cron.json` 7 个 job 全部删除。重启 WebUI 后 `GET /api/cron/jobs` 返回 `[]`。
8. **自动化测试** — 125/125 server + 18/18 web 单元测试 pass;`npm run check` 干净。新增 4 个回归测试覆盖 cwd 解析、agent echo (mock pi stdout 验字段名)、DELETE 乐观 (验响应 <500ms)、session 标题更新。
9. **浏览器端到端** — 用 chrome-devtools 走通 4 个真实场景:(a) 主页空状态 + 看到真 sessions (b) 输 "nihao" 收到真回复 (c) 删除 session 200ms 内消失 (d) Cron 页空表。
