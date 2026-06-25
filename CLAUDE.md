# CLAUDE.md

Project-wide principles distilled from archived SDD changes. These apply to all
work in this repo; per-change principles are in `docs/sdd/archive/<change>/principles.md`.

## Satellite 远程执行原则

- Guardrail 拦截后返回 guidance error,不静默默重定向——让模型看见错误才能自纠正
- satellite 子工具 schema 与原生 pi 工具完全对齐:参数名、类型、可选性、description 一致
- `transfer_file` 走 HTTP body 传输,文件内容不经过 LLM context tokens
- `transfer_file` direction 字面量只有 `upload`/`download`,agent 必须显式声明方向
- bash guardrail 最多容忍 2 次同一模式违规,第 3 次返回硬错误
- 合法 bash 命令不受拦截(仅拦截 cat/sed/echo >/find 模式)
- 远程路径模式通过 `SATELLITE_GUARD_PATTERN` env var 配置,默认为空(不启用 guardrail)

## ask_user_question tool + webui card 原则

- **Extension tool schema 宽松接住、严格使用**: TypeBox schema 必须能接住 model 实际给出的所有畸形参数形态(嵌套 wrapper / 缺字段 / 字段类型不严),在 execute 内部 normalize 后再走严格逻辑。"model 幻觉 + 严 schema = 直接 422"是绝对要避免的反模式
- **Pi 上游已有的能力用 stock 原语组合,不去 fork 上游**: `ctx.ui.select` + `ctx.ui.input` 已经够用,不要为了"理想 UI"去提 PR;失去的可升级性是真实代价,得到的完美 UI 是稀薄收益
- **历史错误不重写**: session jsonl 里的 `Tool X not found` 之类历史错误是真实事件,fix 上线后不改写
- **Webui card 卡片不阻 flow**: 卡片 inline 流内,不 z-index/fixed,不遮挡其他内容
- **Webui card 操作后回显**: 用户选后 disabled 卡片不消失,上方显示选择结果,history 可回溯
- **Webui card 集成助手消息**: 卡片嵌入包含 toolCall 的助手消息内部,不是独立 message entry
- **Webui card 后端不改**: 保留 ask_user_question.ts / session-pool.ts / ws/handler.ts 不动,只改 webui client 渲染
- **Webui card 单选即时**: 点 option 瞬间发 ws 并 disable,不需额外 Submit 按钮
- **Webui card 多选编号**: 卡片内 input box 输 "1,3" 格式,Submit 发逗号分隔 label
- **Webui card 超时不丢人**: 卡片 disabled + 显示 "已超时",保留历史(不消失不隐)
- **rpc-mode 协议 id ≠ toolCall id**: `extension_ui_request.id` 是 `crypto.randomUUID()`,跟 toolCall 的 `call_00_...` 无关。Client 必须按 recency 匹配最近的 ask_user_question toolCall,不能用 id 字段匹配
- **server 回传 id 是 request UUID,不是 toolCall id**: server 的 `pendingExtensionRequests` map key by 请求 UUID,client 必须存 `requestId` 在 cardState 上,提交时 echo 这个 UUID
- **`tool_execution_end.result` 是对象不是字符串**: pi agent runtime 把 tool 的 return value `{content:[{type:"text", text:"..."}], details:{...}}` 作为 result 字段。Client 必须先 extract `result.content[0].text`,不能直接调 `.includes` 等 string method — 否则 React 整个 ChatPage 子树会因为未捕获异常被卸载

## agent-loop-recall-and-file-tracking 原则

- Steer 入口必须与 prompt() 入口对扩展钩子系统等价,任何监听 `before_agent_start` 的扩展都能感知新主题
- 文件操作跟踪优先覆盖高频简单模式(> mv cp rm sed -i),不追求 AST 完整性,接受 ~20% 边缘场景漏报
- grep/find/ls 的输出通过反向 regex 提取文件路径,视作"读取"语义,不改文件状态
- 不为路径提取引入新的运行时依赖(shell parser/AST 库),维持 pi 的零外部依赖原则
- 被动注入 + 扩展钩子 + 阈值控制是记忆系统核心范式,本次修改不引入新机制(不主动 tool / 不滑动窗口)
- 工具结果截断(50KB / 2000 行)已是 baseline,文件跟踪 regex 必须正确处理 truncated 边界,不假设完整输出
- 边界 case 降级而非报错,任意文件跟踪失败不应阻塞压缩流程

## memory-v2 原则

- 记忆系统使用纯向量检索,删除 FTS5、混合检索、BM25 评分。
- LLM 只决定记忆的内容(type/title/content/tags/importance),代码决定存储策略(skip/supersede/create),LLM 不再决定 create/update/skip。
- 内容指纹(sha256 标准化 content)+ 嵌入余弦相似度阈值(默认 0.92)是去重的唯一依据,token 词袋 Jaccard 不再使用。
- 记忆类型简化为三大类(rule/fact/process),每类对应一个目录;rule 类型永不因衰减自动归档。
- 记忆文件路径使用 atom.id 作为文件名,不基于 title slug,避免 slug 冲突覆盖。
- 注入采用 L0(summary)/L1(content)双层结构,L1 仅对 top-N=3 触发,默认 token budget 4000。
- 召回失败(embedding 服务不可用)直接返回空结果,无 FTS 兜底、无 LLM 改写回退。
- 写入路径使用 SQLite 事务保证原子性(supersede 旧 atom + 插入新 atom 在同一事务),fingerprint 唯一索引防并发重复写入。
- 嵌入向量化时机:写入时同步算(去除网络依赖)、编辑后重算、归档时删除向量。
- 旧数据不迁移,新 DB 从零开始,production 现有 177 atom 废弃。
- **测试 fixture 含真实会话**: `extensions/personal-assistant/test/fixtures/session-sample.jsonl` 是用户真实 session 截取 (416KB,最后 200 条),含用户名/项目路径/LLM 完整响应。仓库为私人项目 (no upstream sync),接受此风险,不替换为合成数据。
- **embed.ts 无 SSRF guard**: `embed.ts` 直接 fetch `cfg.ollamaUrl` (默认 `http://127.0.0.1:11434`),未复用 `tools.ts` 的 `isPrivateIP` guard。接受风险 — 设计假设 ollama 始终是本地内嵌服务,config 仅 trusted local 来源写入 (settings.json 不可被未授权用户修改)。如未来 config 可被 prompt 注入或 webui 写入,需补 guard。
- **召回 memory 无结构化分隔**: 召回 atom content 直接拼接到 user message (`memory.ts` context hook),不包裹 `<memory-context>` 标签。LLM 可能将 memory content 误识别为 instruction。接受 — local-only threat model + memory 来源已 controlled (LLM 自身提取 + PATCH 需要 access to webui)。

Verbatim from docs/sdd/changes/memory-v2-refactor/principles.md

## webui-memory-page 原则

- **`MemoryIndex` 是 personal-assistant 的 public API**：class 和 `MemoryAtom` / `MemoryAtomType` / `searchAtoms` / `rewriteQuery` / `writeAtomToFile` / `readAtomFromFile` / `ATOMS_DIR` / `MEMORY_DB_PATH` 必须 export；webui server 通过 tsconfig path mapping 直接 import，不重复实现 SQLite 读写
- **`.md` 文件是 single source of truth，DB 是索引**：body 编辑必须重算 hash、可能重写文件、可能迁移 `file_path`、必重建 FTS 行、必清 embedding
- **编辑必落盘**：3s debounce + 路由切换 / 关闭 tab / 刷新页面时强制 flush pending save，不丢用户输入
- **Recall 测试 = 真实 pipeline**：不 mock、不写测试专用的 search 函数；调真实的 `rewriteQueryWithCallLlm` + `searchAtomsWithScores`，展示分项分数让用户能定位召回失败原因
- **v1 不做 create / delete atom**：atom 由抽取流程自然生成，UI 手动 create 容易污染模型对真实用户偏好的判断；delete 用归档（`archived=true`）替代
- **编辑失败 = 视觉反馈 + 一次重试**：toast 提示、in-memory 值回滚、3s 后再试一次，第二次失败停手，不无限循环
- **Server 端走 `callLlm` 回调，不构造 `ExtensionContext` stub**：`ExtensionContext.modelRegistry` 强耦合 session 生命周期，stub 易跑偏；server 永远用 `*WithCallLlm` 形态访问 LLM 能力，和现有 `runMemoryExtraction` 一致

## memory-search-get-decoupling 原则

- search 是纯向量检索，不 bump `access_count`，不返 `file_path`，只返 `{id, type, title, summary, tags, distance, cosine, score}` 让 LLM 看到 candidates
- LLM 想拿全文必须显式调 `memory_get(id)` tool，这是 strength feedback 的**唯一**程序入口
- webui 的 `GET /api/memory/:id` 仅用于内容预览，**不**触发 bump，与 agent 端的 memory_get 严格区分
- `recallAtoms` 按 type 分层 KNN：rule/fact/process 各取 top-3，稀疏 type 自动降到 1，保证类型多样性
- search 排序算法：**乘法 boost 公式** `score = cosine × (1 + 0.3 × strength + 0.2 × importance)`，组内按 score DESC 排序；**组间 round-robin 交错**（3 type × 3 cap → 最多 9 results）；全局 threshold 0.5，稀疏 type 跳过不凑数；`formatMemoryContext` 注入 prompt 时再做 distance asc 全局排序（只看 cosine 主键，score 仅影响 search response / debug 视图）
- 乘法结构保证 cosine 仍是主键 — cosine 趋近 0 时 score 必趋近 0，不相关 atom 不可能被 boost 反超；max boost 0.5 意味着 cosine 必须 ≥ 0.667x 才能仅靠 cosine 嬴
- strength 直接进入 feedback 循环：get → strength 高 → score 高 → 排名靠前 → 更容易被未来 recall → 更频繁被 get
- importance 反映作者/LLM 静态优先级，rule type 永远 ≥ fact/process，所以 rule 在 cosine + strength 相同时自然胜出
- `runDecay` 现有行为（baseDecay=0.05, archiveThreshold=0.1, rule 永不 archive）不变 — strength 衰减让 score 自然下降，排名下降后进一步 decay，最终触发 archive，形成完整"遗忘 → 清理"链条
- `formatMemoryBlock` 输出 `[type] title\nsummary\nid: <uuid>\nTags: ...`，LLM 通过 id 反查 `memory_get` 拿全文
- importance 由 extraction LLM 在收到 `<user_tone>` hint 后**自主**判断，词表扫描只决定 hint 强度（strong/habit/neutral/weak/rare），不直接覆写 LLM 输出；LLM 可在 ±0.15 范围内调整
- `scoreUserTone` 纯词表匹配（中英双语 ~20 词，5 档 strong/habit/neutral/weak/rare），不调 LLM，微秒级；**聚合所有 user 消息**取最强命中 tier，NEUTRAL 等级不向 prompt 注入任何 hint
- TUI footer 通过 `ctx.ui.setStatus("memory", …)` 显示召回摘要（hits: `📦 N atoms · rule=X fact=Y process=Z · top=0.XXX`；空: `🔍 no memory match`；失败: `⚠ memory recall failed`），让用户在不打开 webui 的情况下也能看到 memory pipeline 状态——LLM prompt 注入 + TUI 状态双轨

## memory-hybrid-bm25-recall 原则

- 召回融合默认走 RRF (Reciprocal Rank Fusion),不归一化 BM25 与 cosine,只取 rank 加权 — 量纲不同、分布不同的 score 强行相加不稳,RRF 用 `1/(k+rank)` 自然规避
- FTS5 行同步在 storage 层原子化,与 memory_index 同事务,FTS5 行只描述 active 文本层(不含 embedding),archive / supersede 立即让 FTS5 行失效
- 召回配置只暴露 `rrfK` 和 `recallThreshold` 两个 knob,其他全部硬编码在 `search.ts` — 加 knob 等于让用户调自己不懂的参数,YAGNI
- `recallThreshold` 默认 `1/rrfK` (= 1/60 ≈ 0.01667 with rrfK=60),意味着单 channel rank=1 (0-indexed, 贡献 1/(rrfK+0+1) = 1/61 ≈ 0.01639) 单独命中**不足以**过阈值,必须双 channel 都命中 OR 单 channel 极强 — 这是"宁可漏召不可误召"的保守姿态,保护 dense noise case (用户的 lefse 场景)
- 召回对单 channel 降级鲁棒:dense 失败 → 纯 BM25 仍工作;BM25 返回 0 → 纯 dense 仍工作;两者都失败 → 返回 `[]`(同旧行为)
