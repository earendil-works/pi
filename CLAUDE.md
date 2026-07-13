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

- **`MemoryIndex` 是 personal-assistant 的 public API**：class 和 `MemoryAtom` / `MemoryAtomType` / `searchAtoms` / `writeAtomToFile` / `readAtomFromFile` / `ATOMS_DIR` / `MEMORY_DB_PATH` 必须 export；webui server 通过 tsconfig path mapping 直接 import，不重复实现 SQLite 读写
- **`.md` 文件是 single source of truth，DB 是索引**：body 编辑必须重算 hash、可能重写文件、可能迁移 `file_path`、必清 embedding
- **编辑必落盘**：3s debounce + 路由切换 / 关闭 tab / 刷新页面时强制 flush pending save，不丢用户输入
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

## webui-collapsible-thinking-step 原则

- **Step wrapper 是 webui-only 渲染抽象**: 把 assistant turn 包成可折叠 step 是 webui 的 UI 关注点,TUI / JSONL / 后端都不感知。Step 边界由 `MessageParts` 渲染层自己定,不动数据模型
- **Step body 只包 inference (thinking + tool + image),text 在 fold 外**: fold 用于隐藏"过程"(可折叠 = 过程性、可隐藏),text 是"结果"(必须始终可见)。`chunks` 拆为 `inferenceChunks` + `textChunks`,fold 包前者,后者作为 sibling 渲染。Streaming 中间 text delta + 最终 reply 都走 textChunks 路径
- **Step wrapper 触发条件:含 thinking 或 tool 或 image**: 纯 text turn 不裹 fold,保持改动前视觉。判断由 parts 的 type set 决定,0 运行时成本
- **isStreaming 是单向上下文**: 父组件 (ChatPage) 知道 `isThinking`,通过 prop 透传到 MessageBubble → MessageParts。子组件不读 store / 不发请求
- **Step collapsed/expanded 状态用 useState**: 用户点击 toggle 改变本地 state,无持久化、无 URL 参数。刷新页面后 step 默认按 `isStreaming` 决定(流中展开,流完折叠)
- **Duration 显示冻结在完成时刻**: 用 `useRef<completedAt>` 记下 step 关闭的时间戳,header duration 算 `completedAt - startedAt` 而不是 `Date.now() - startedAt`。完成后不再 tick,旧 turn 看到的还是真实耗时,不是缓慢增长的"since-timestamp"近似

## memory-pipeline-hardening 原则

- 写入路径优先走"已有 supersede 机制",webui PATCH 不绕过 extraction 的 cosine 去重门
- 客户端乐观更新必须带 `If-Match` 版本号,服务端用 409 终止冲突而非无声覆盖
- 单 atom 状态推送优先走 SSE(零冗余),仅在 SSE 不可用时回退轮询
- tag 写入是归一化操作(merge alias + 去重),不是字符串透传
- 检索打分公式扩展维度时,既有 `cosine × (1 + 0.3s + 0.2i)` 主项保持向后兼容

## memory-recall-dense-rerank 原则

- 召回是纯 dense 单通道:sqlite-vec KNN + cosine floor 是唯一门控,无 BM25/FTS/RRF 融合。bge-m3 多语言语义检索 + tagOverlap 精确匹配覆盖个人 atom 库规模(几百条)的全部检索需求。
- 宁可漏召不可误召:cosine floor 0.7 是硬门控,低于 floor 的候选不进结果列表。dense 是唯一通道,门控必须严(0.65 → 0.7),无 BM25 兜底。
- 删通道必删同步:删 BM25 通道必须同步删 storage 层所有 FTS 行同步逻辑(insert/supersede/archive 三处),不能留死代码引用已删的 `memory_fts` 表。
- 删功能必删配置:删 query rewrite 必须同步删 `PersonalAssistantConfig.memory.queryRewrite` 字段和 `settings-manager.ts` 的 `query_rewrite` 字段,配置不能引用不存在的功能。
- 删功能必清文档:删功能必须同步清理 CLAUDE.md / spec.md 中引用该功能的段落,文档不能描述已删除的行为。
- scoring 公式不可变:`cosine × (1 + 0.3s + 0.2i) + 0.10×tagOverlap + 0.05×freshness` 是稳定 API,乘法锚保证 cosine 主键地位,删 BM25 不影响 scoring。
- per-type top-3 + round-robin 不可变:rule/fact/process 各取 top-3 + 交错合并是类型多样性保证,与召回通道无关。
- L0 discovery-only 不可变:召回只返 `{id, type, title, summary, tags, distance, cosine, score}`,全文由 `memory_get(id)` 按需取,不注入 prompt。

## atom-remigrate 原则

- 迁移不可逆操作必须有备份,出错可手动 cp 回滚。
- LLM 输出需逐批校验,失败 batch 不影响后续 batch。
- id 是 stable anchor,所有 in-place 改必须保留 id,version+1 即可。
- bge-m3 向量跟文本强一致,文本改完必须 reindex,失败要 warn 不中断。
- 召回策略改动不在本变更范围,改 atom 文本是唯一信号源。
- **cosine 是候选信号,LLM 是决策信号**: 程序找候选 (1ms cosine 命中),LLM 看候选决定怎么处理 (200ms 二次确认)。两者串联,快+准。
- **同 0.65 阈值,不同行为**: 目标 1 (批量迁移) 程序直接 supersede;目标 2 (实时 extract) LLM 二次确认。阈值一致防漂移,行为差异因场景价值不同。
- 旧 atom 的 source_session 几乎全 null,本变更不尝试回填 (那是另一个 change)。
- **本变更不扩张 atom 长度**:迁移只合并,extract 优化只加规则,不加"加长 content"指令。
- **tag 一致性是 LLM 的责任也是程序的责任**: LLM emit 优先复用字典;程序端做归一化兜底,概念性 tag 缺失则 warn。
- **主动更新而非扩张**: LLM extract 看到新信息归入已有 atom,优先 update 而非 create。程序端 cosine 0.65 兜底 + LLM 二次确认 (目标 2)。
- **新会话 30 天后 corpus tag 重复率 ≥ 2.0**:每个 tag 平均被 ≥ 2 atom 使用才算"字典成体系"。

## gate-multiquery 原则

- gate 只做二分 (`need_memory`),不再做 query rewrite — 单职责 LLM call 是小模型可靠性的边界条件,双任务让 3b 的两个产出都掉点
- rewrite 是独立阶段,统一处理 disambiguation + multi-concept split,不与 gate 共享 prompt,失败降级到单 `[rawQuery]` 与今天等价
- subquery 上限 3 是 LLM 行为护栏,不是性能护栏 — 阻止小模型在简单 query 上凑数生造低质子查询
- 同 atom 被多 subquery 召回时,merge 取 rerankScore 最高那一路 — 每 subquery 独立 rerank 后 max(同 id) 比 join 后 rerank 数学上保真 (实际验证:复合 query "MGM项目的工时如何计算" join 后 MGM atom 0.97→0.34 跨过 0.5 threshold 死区)
- rerank 拿的 query 是 per-subquery 独立打分,而非 joined 字符串 — cross-encoder 在复合 query 上加 disjoint 概念会互相稀释,导致两边都过不了 threshold
- webui `filtered=true` 单一开关包含 rewrite+rerank 全链路 — 不为 rewrite 单独开 flag,避免组合爆炸配置
- rewrite 失败不阻塞 pipeline — non-blocking 是 hard contract (AGENTS.md principle 6 既有原则,本变更复用)
- gate 删除 `search_query` 字段是 breaking change on schema — 老 settings.json / 老 test 都要同步改,不允许保留向后兼容 (per AGENTS.md "不保留 backward compat")
- 三阶段串行 (gate → rewrite → recall+rerank) 总时延约 10.5s,可在 context hook 8s 预算外 — 已知 trade-off,2026-07-04 gate 从 500ms 延长到 5000ms 以覆盖冷启 ollama qwen2.5:3b 加载,warm 路径典型 2-3s。每阶段 timeout (gate 5000ms / rewrite 5000ms / rerank 500ms) + recall 50ms + format 微秒级。KNOWN RISK: 当前未把 AbortSignal 从 `pi.on("context")` 串到 callGate/rewriteQueries,phase 内 fetch 不会被父 deadline abort,慢 ollama 可能 stall 输入到 timeout 上限(security MEDIUM,属本修复 scope 外)。
- merge helper 是 pure function,@sdd-guide 的 unit test 优先级高于 rewrite 的 mock fetch test
- debug log 行扩展为 `[recall] gate=X rewrite=Y(N) recall=Z rerank=W ...` — `rewrite=Y(N)` 输出 `ok(2)` / `timeout` / `parse` / `[raw]`,单行可读
- **webui search endpoint 安全门**: topK clamp 到 [1,100], type 必须 ∈ {rule,fact,process} allowlist, 60/min/IP rate limiter 保护 (loopback-only 但防本地 misbehavior)

## agent-driven-memory-save 原则

- agent-driven `memory_save` 是 memory 写入的主路径,`session_before_compact` 退化为仅在 agent 整段对话零调用时的兜底
- 去重走 fingerprint (sha256(normalized content).slice(0,16)) + LLM oldId 决策两条路径,与 extract pipeline 共享同一函数 `extraction.ts:executeItem`;不引入 cosine gate 或 LLM 二次确认(2026-07-09 commit 2a9697795 已锁定)
- overwrite 走 `MemoryIndex.updateAtom` in-place UPDATE(保留 id,SQL 自动 `version = version + 1`),不删不插;supersede 链仅由 webui PATCH `supersedeIfSimilar` 路径产生,与 agent `memory_save` 正交
- agent 不可绕过 `memory_save` tool 直接落盘 `~/.pi/agent/memory/atoms/**`,`tool_call` hook 必须硬阻断 `write` / `edit` / `bash` 写该路径(读不受限;`writeAtomToFile` 经 fs 直调,不经 hook,自洽)
- safety net 失败必须 graceful skip,不再取消 compact;抽取不可达是工程常态,不是用户错误
- embedding 服务不可达不阻塞写入,atom 入库但 vector 用 zero-vector fallback(`embedding ?? new Array(1024).fill(0)`),recall 走 bge-m3 sparse channel 兜底
- agent save 计数用于触发 safety net 判定,计入"调用"而不计入"成功"(被 fingerprint 拒也算 agent 主动管理过 memory)
- TUI context hook 与 webui `/api/memory/search` 必须通过同一 `recallPipeline()` 函数完成 rewrite → recall → rerank → merge,除 gate 外不接受 pipeline 漂移
- `recallPipeline` 接受 `recent: string[] | null` 参数,TUI 传前 3 条 user msg(指代消解),webui 默认传 null(无会话上下文);`topK` 默认 20 两路径一致
- `recallPipeline` 是 TUI 与 webui 唯一的 recall 入口;inline 重复实现视为 regression,review 阶段必须拒绝
