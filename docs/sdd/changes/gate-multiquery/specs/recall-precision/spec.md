# recall-precision Specification (MODIFIED)

Capability: gate + cross-encoder rerank 截断. 本变更只修改 gate schema (MODIFIED),不增加或删除其他 Requirement.

## MODIFIED Requirements

### Requirement: Recall gate via local LLM (qwen2.5:3b)
memory recall pipeline SHALL 在 `context` hook 入口先经过 gate LLM 决策: 给定当前 user msg + 最近 2-3 条 user msg, 输出 `{need_memory: boolean}`. gate 走 ollama qwen2.5:3b-instruct-q4_0 (温度 0), 500ms 超时, 失败一律降级 skip 召回 (不 fallback 走原 RRF), TUI 显示对应状态. Query rewrite 任务不再由 gate 承担, 改由独立 `rewriteQueries` 阶段处理 (见 recall-multiquery capability).

#### Scenario: 指代性 short query 被 gate 拦截 (S1)
- **GIVEN** recent user msgs = ["把 search_3n_path.py 改成异步的", "改成异步后跑一下"], 当前 = "上面的脚本有问题"
- **WHEN** gate 调用 qwen2.5:3b
- **THEN** 输出 `{need_memory: false}`, recall 被跳过, TUI 显示 "🚫 gate skipped", 端到端延迟 < 500ms

#### Scenario: 零信息量 ack query 被 gate 拦截 (S2)
- **GIVEN** recent = ["列一下 TODO"], 当前 = "对"
- **WHEN** gate 调用
- **THEN** 输出 `{need_memory: false}`, 跳过 recall, status "🚫 gate skipped"

#### Scenario: 历史回溯 query 被 gate 通过, rewrite 负责改写 (S3)
- **GIVEN** recent = ["我们之前用 bwa 做过引物验证", "做了 但是有个并发问题"], 当前 = "之前那个并发问题最后怎么解决的"
- **WHEN** gate 调用
- **THEN** 输出 `{need_memory: true}`, 后续 rewrite 阶段负责把指代消解为 "search_3n_path.py 异步并发问题修复" 或类似 search key, recall 用 rewrite 输出而非原 msg

#### Scenario: gate JSON 解析失败降级 skip (S5)
- **GIVEN** qwen2.5-3b 返回不合法 JSON
- **WHEN** gate 解析 (strip 前后非 `{...}` 段后重 parse) 仍失败
- **THEN** 返回 null, skip 召回, status "🚫 gate skipped (parse failed)"

#### Scenario: gate 500ms 超时 (S6)
- **GIVEN** ollama 500ms 内未响应
- **WHEN** AbortController 触发
- **THEN** 返 null, status "⚠ gate timeout, skipped"

#### Scenario: ollama 服务挂掉 (S7)
- **GIVEN** ollama ECONNREFUSED
- **WHEN** gate fetch 抛
- **THEN** catch 内吞掉, status "⚠ gate down, skipped"

#### Scenario: gate 返 need_memory=false 时 rewrite 不调 (E6)
- **GIVEN** gate 返 `{need_memory: false}`
- **WHEN** context hook 处理
- **THEN** rewrite 不被调, debug log 显示 `gate=skip-false rewrite=skip(pre-gate-skip)`, pipeline 立即 return original event

#### Scenario: gate timeout 时 rewrite 不调
- **GIVEN** gate 返 "timeout"
- **WHEN** context hook 处理
- **THEN** rewrite 不被调, debug log 显示 `gate=timeout rewrite=skip(pre-gate-skip)`, TUI status "⚠ gate timeout, skipped"