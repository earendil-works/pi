# 本变更原则

<!-- 一句话一条，里程碑追加到 CLAUDE.md -->

- TUI 视觉改进通过主题 JSON 文件实现，不修改默认主题。
- 新主题必须通过 `theme-schema.json` 校验，颜色值必须使用 hex 格式。
- Footer mode chip 使用语义颜色（Plan=amber, Agent=blue, YOLO=red），不使用随机色。
- 消息卡片背景色必须与文字色对比度 ≥ 4.5:1（WCAG AA）。
