# 新增图的技术底稿与验收

基线 `56cae7823`。以下提示通过内置 imagegen 生成，底层型号未返回。图中序号、简写和预算数字是教学示意。每张图先核对正文推演，再检查实际像素图的对象归属、方向和条件。

## 03-1

[打开图片](figures/03-1.png) · [对应正文](03-messages.md)

教学问题与约束如下。

消息放在哪个容器？画三个嵌套放大镜框：SessionEntry 内 message 指向 AgentMessage，AgentMessage 的 content 有两个 toolCall A、B；下方独立 AgentEvent 流写 start、update、end。条目边标 id 与 parentId，调用边标 id 与 toolCallId。明确事件流是旁路。

源码依据：[agent/src/types.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/types.ts) · [agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [coding-agent/src/core/messages.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/messages.ts) · [coding-agent/src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/agent-session.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 03-2

[打开图片](figures/03-2.png) · [对应正文](03-messages.md)

教学问题与约束如下。

十次更新为什么只记一条回复？横向时间线 message_start → message_update ×10 → message_end；下方历史轨道仅在 end 向下箭头追加一条 assistant。不要把 update 画成历史节点。

源码依据：[agent/src/types.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/types.ts) · [agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [coding-agent/src/core/messages.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/messages.ts) · [coding-agent/src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/agent-session.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 04-1

[打开图片](figures/04-1.png) · [对应正文](04-tree.md)

教学问题与约束如下。

追加顺序与当前路径。左画 E1、E2、E3 的时间带，右画 E1 分叉到 E2、E3 的树。E3 为当前叶，紫色突出路径 E1→E3，E2 灰色。树边标父到子。

源码依据：[coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/session-manager.ts) · [coding-agent/test/session-manager/tree-traversal.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/tree-traversal.test.ts) · [coding-agent/test/session-manager/file-operations.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/file-operations.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 04-2

[打开图片](figures/04-2.png) · [对应正文](04-tree.md)

教学问题与约束如下。

切分支和 fork 各改变什么？左侧一个会话文件中 E1 分叉 E2/E3，叶指向 E3。右侧原文件和新文件两个容器，新文件头写 新会话身份、parentSession 指向原文件；虚线标复制历史。不要暗示同步。

源码依据：[coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/session-manager.ts) · [coding-agent/test/session-manager/tree-traversal.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/tree-traversal.test.ts) · [coding-agent/test/session-manager/file-operations.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/file-operations.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 05-1

[打开图片](figures/05-1.png) · [对应正文](05-projection.md)

教学问题与约束如下。

六条记录为何只剩两条消息？从左到右路径 E1用户 E2助手 E3结果 E4隐藏E3 E5隐藏E2 E6用户；中部 E4→E3、E5→E2 标编辑目标；右输出 E1、E6。注明独立投影例，非完整工具对话。

源码依据：[coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/session-manager.ts) · [coding-agent/test/session-context-edit.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-context-edit.test.ts) · [coding-agent/test/session-manager/build-context.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/build-context.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 05-2

[打开图片](figures/05-2.png) · [对应正文](05-projection.md)

教学问题与约束如下。

来源与贡献并存。上排六个来源 E1 E2 E3 E4 E5 E6，下排对应贡献 [用户] [] [] [] [] [用户]，逐列细线一一对应；最下方 flatMap 输出两条用户消息。E4、E5 是上下文编辑。

源码依据：[coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/session-manager.ts) · [coding-agent/test/session-context-edit.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-context-edit.test.ts) · [coding-agent/test/session-manager/build-context.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/build-context.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 06-1

[打开图片](figures/06-1.png) · [对应正文](06-memory.md)

教学问题与约束如下。

模型输入如何装配？从左至右管道 项目文件与系统说明 → 会话记录及当前叶 → 投影 → transformContext → convertToLlm → 模型接口。项目文件连接系统说明，历史连接投影，避免把文件直接连模型；下方注 每个阶段可改变本次输入。

源码依据：[coding-agent/src/core/system-prompt.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/system-prompt.ts) · [coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/session-manager.ts) · [coding-agent/src/core/compaction/compaction.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/compaction/compaction.ts) · [coding-agent/test/session-manager/build-context.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/build-context.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 06-2

[打开图片](figures/06-2.png) · [对应正文](06-memory.md)

教学问题与约束如下。

第一次压缩。上轨原路径 E1 E2 E3 C1 E4；C1 下注 firstKeptEntryId=E3；下轨来源 C1 E3 E4，C1 标系统状态与摘要。用保留区间括号 E3，灰色省略 E1 E2，禁止删除符号。

源码依据：[coding-agent/src/core/system-prompt.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/system-prompt.ts) · [coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/session-manager.ts) · [coding-agent/src/core/compaction/compaction.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/compaction/compaction.ts) · [coding-agent/test/session-manager/build-context.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/build-context.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 06-3

[打开图片](figures/06-3.png) · [对应正文](06-memory.md)

教学问题与约束如下。

第二次压缩怎样处理旧摘要？上轨路径 E1 E2 E3 C1 E4 C2，C2.firstKeptEntryId=E3。下轨投影来源 C2 E3 C1 E4；C2贡献新摘要，C1贡献空数组，E3 E4保留消息。明确来源存在不等于消息贡献。

源码依据：[coding-agent/src/core/system-prompt.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/system-prompt.ts) · [coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/session-manager.ts) · [coding-agent/src/core/compaction/compaction.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/compaction/compaction.ts) · [coding-agent/test/session-manager/build-context.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/session-manager/build-context.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 07-1

[打开图片](figures/07-1.png) · [对应正文](07-loop.md)

教学问题与约束如下。

循环何时继续？模型响应后菱形 有工具调用？ 有则工具批次及结果，后到轮次结束；无也到轮次结束。随后检查 steering、follow-up、显式续轮，满足则回下一次请求，否则 agent_end。标简化控制流，finishTurn 可提前结束。

源码依据：[agent/src/agent.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent.ts) · [agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [coding-agent/test/suite/agent-session-queue.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/suite/agent-session-queue.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 07-2

[打开图片](figures/07-2.png) · [对应正文](07-loop.md)

教学问题与约束如下。

两种输入队列的交付时机。横向 当前响应→工具批次→下一请求→自然停止。steering 从队列连下一请求边界；follow-up 从队列连自然停止后的再启动。取消信号另画向当前执行的虚线，注明协作式。

源码依据：[agent/src/agent.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent.ts) · [agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [coding-agent/test/suite/agent-session-queue.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/suite/agent-session-queue.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 08-1

[打开图片](figures/08-1.png) · [对应正文](08-tools.md)

教学问题与约束如下。

工具的两种形态。宿主框 AgentTool 包含名称、说明、schema、execute；从前三者向模型声明箭头，execute留宿主。模型返回 toolCall A(path=A.json) 回宿主准备校验，再指向 execute，结果 toolCallId=A 回模型输入。

源码依据：[agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [coding-agent/src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/agent-session.ts) · [coding-agent/test/suite/agent-session-tool-orchestration.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/suite/agent-session-tool-orchestration.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 08-2

[打开图片](figures/08-2.png) · [对应正文](08-tools.md)

教学问题与约束如下。

参数怎样过执行边界？调用 → 查名称 → prepareArguments → schema校验 → beforeToolCall → execute → toolResult。查找失败、校验失败、钩子阻止分别汇到错误结果；不让错误分支连 execute。

源码依据：[agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [coding-agent/src/core/agent-session.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/agent-session.ts) · [coding-agent/test/suite/agent-session-tool-orchestration.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/suite/agent-session-tool-orchestration.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 09-1

[打开图片](figures/09-1.png) · [对应正文](09-scheduling.md)

教学问题与约束如下。

整批串并行选择。assistant 内两个调用 A、B，分支判断 全局串行 或 任一工具要求串行。是→A结束后B；否→A与B可重叠。两个分支互斥，末端均为按原调用序的结果。

源码依据：[agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [agent/test/agent-loop.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/test/agent-loop.test.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 10-1

[打开图片](figures/10-1.png) · [对应正文](10-failures.md)

教学问题与约束如下。

结构正确仍可能截断。模型响应 stopReason=length → 所有调用返回错误 → 下一轮可重提。另一互斥分支 完整响应 → 参数准备和校验 → 执行。length分支不得经过工具execute。

源码依据：[agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [agent/test/agent-loop.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/test/agent-loop.test.ts) · [coding-agent/src/core/tools/read.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/tools/read.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 10-2

[打开图片](figures/10-2.png) · [对应正文](10-failures.md)

教学问题与约束如下。

错误发生在哪个窗口？横向 准备前→校验后→执行开始→外部动作→结果。上方标未知工具/参数错误在执行前；下方标执行抛错可能在外部动作后。右侧结果均可 isError=true；底注 错误标志不足以判断副作用。

源码依据：[agent/src/agent-loop.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/src/agent-loop.ts) · [agent/test/agent-loop.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/agent/test/agent-loop.test.ts) · [coding-agent/src/core/tools/read.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/tools/read.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 11-1

[打开图片](figures/11-1.png) · [对应正文](11-storage.md)

教学问题与约束如下。

三类持久对象与一次提交。会话存储外框，内部三列 Entry对话事实、Document可变状态、Task检查点；commit括号同时包住 追加assistant、更新LiveDoc、创建tool任务及waiting。不要画三类互相转换。

源码依据：[durable/README.md](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/README.md) · [durable/src/harness/generation.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/generation.ts) · [durable/src/documents.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/documents.ts) · [durable/test/examples/34-submit-in-commit.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/34-submit-in-commit.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 11-2

[打开图片](figures/11-2.png) · [对应正文](11-storage.md)

教学问题与约束如下。

提交的可见性边界。时间向右，构造变更→存储提交→发布观察。提交前崩溃分支显示旧状态；提交成功后崩溃分支显示新状态。外部服务单独边界，标不在本次存储原子范围。

源码依据：[durable/README.md](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/README.md) · [durable/src/harness/generation.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/generation.ts) · [durable/src/documents.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/documents.ts) · [durable/test/examples/34-submit-in-commit.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/34-submit-in-commit.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 12-1

[打开图片](figures/12-1.png) · [对应正文](12-task-graph.md)

教学问题与约束如下。

提交输入到回答的任务流。submit→inbox→pi.generation→工具批次→下一次生成→最终answer。generation分叉拥有 pi.tool A 和B，虚线返回等待集合 on=[A任务,B任务]，ownership与等待使用不同线型。

源码依据：[durable/src/harness/generation.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/generation.ts) · [durable/src/harness/inbox.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/inbox.ts) · [durable/test/examples/02-forks.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/02-forks.ts) · [durable/test/examples/03-owned-conversations.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/03-owned-conversations.ts) · [durable/test/examples/23-child-tasks.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/23-child-tasks.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 12-2

[打开图片](figures/12-2.png) · [对应正文](12-task-graph.md)

教学问题与约束如下。

三种边不能混读。三个并列结构：历史fork从会话X分到Y标继承可见历史；任务所有权父T拥有子A/B；等待T虚线指A/B标何时唤醒。注明取消与上下文要分别查关系。

源码依据：[durable/src/harness/generation.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/generation.ts) · [durable/src/harness/inbox.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/inbox.ts) · [durable/test/examples/02-forks.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/02-forks.ts) · [durable/test/examples/03-owned-conversations.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/03-owned-conversations.ts) · [durable/test/examples/23-child-tasks.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/23-child-tasks.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 13-1

[打开图片](figures/13-1.png) · [对应正文](13-recovery.md)

教学问题与约束如下。

持久等待释放调用。阶段 tick(n)→sleepUntil并保存n+1→sleeping(until)→时间到→tick(n+1)；末次tick→terminal completed。阶段框与存储框分开，等待中不画活动调用栈。

源码依据：[durable/test/examples/12-recovery.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/12-recovery.ts) · [durable/src/harness/generation.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/generation.ts) · [durable/README.md](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/README.md)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 13-2

[打开图片](figures/13-2.png) · [对应正文](13-recovery.md)

教学问题与约束如下。

打印的三个崩溃窗口。横向 写memo前｜写memo｜打印｜保存下一检查点。三个下向分支：memo前退出→重跑可打印；memo后打印前退出→可能漏打；打印后提交前退出→memo抑制重复。单位n=2，memo名printed-2。

源码依据：[durable/test/examples/12-recovery.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/12-recovery.ts) · [durable/src/harness/generation.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/generation.ts) · [durable/README.md](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/README.md)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 13-3

[打开图片](figures/13-3.png) · [对应正文](13-recovery.md)

教学问题与约束如下。

连续崩溃如何收敛？任务阶段启动→提交新状态 计数重开；另一支 中断→计数增加→达到restartLimit? 未到再调度，达到终结。旁注 默认5，模型请求按retry另处理，正常close与崩溃分开。

源码依据：[durable/test/examples/12-recovery.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/12-recovery.ts) · [durable/src/harness/generation.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/generation.ts) · [durable/README.md](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/README.md)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 14-1

[打开图片](figures/14-1.png) · [对应正文](14-codemode.md)

教学问题与约束如下。

Code Mode 的执行归属。模型输出脚本→QuickJS沙箱；沙箱调用 tools.read→宿主嵌套工具任务→文件系统；结果先journal后交VM；脚本输出回模型。明确文件读取发生在宿主工具，VM不直接连文件。

源码依据：[durable/src/codemode/codemode.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/codemode/codemode.ts) · [durable/src/harness/tool.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/tool.ts) · [durable/README.md](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/README.md)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 14-2

[打开图片](figures/14-2.png) · [对应正文](14-codemode.md)

教学问题与约束如下。

A已交付，B中断，如何重放？左轨首次 A结果→写journal→交脚本→B运行→崩溃；右轨重跑脚本→复用A日志→关联B原任务→按B的replay策略。分歧/版本或指纹变化→错误出口，禁止A直接重执行箭头。

源码依据：[durable/src/codemode/codemode.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/codemode/codemode.ts) · [durable/src/harness/tool.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/tool.ts) · [durable/README.md](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/README.md)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 15-1

[打开图片](figures/15-1.png) · [对应正文](15-extension.md)

教学问题与约束如下。

新工具从注册到请求。扩展注册 validate_config 的schema与execute→AgentSession装配→模型声明；模型调用→循环校验分派→execute。事件从会话分叉给 TUI、RPC、SDK消费者，入口与消费者标签清楚。

源码依据：[coding-agent/test/suite/agent-session-tool-orchestration.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/suite/agent-session-tool-orchestration.test.ts) · [coding-agent/src/core/extensions/types.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/extensions/types.ts) · [coding-agent/src/core/sdk.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/sdk.ts) · [durable/src/harness/registry.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/registry.ts) · [durable/test/examples/30-reload-and-restart.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/30-reload-and-restart.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 15-2

[打开图片](figures/15-2.png) · [对应正文](15-extension.md)

教学问题与约束如下。

Durable重载何时生效？时间横向，registry v1→安装v2。上轨已启动调用持续用v1到结束；下轨下一阶段解析v2。下方重启存储任务名→registry定义→恢复，缺失定义→阻塞。

源码依据：[coding-agent/test/suite/agent-session-tool-orchestration.test.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/test/suite/agent-session-tool-orchestration.test.ts) · [coding-agent/src/core/extensions/types.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/extensions/types.ts) · [coding-agent/src/core/sdk.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/coding-agent/src/core/sdk.ts) · [durable/src/harness/registry.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/src/harness/registry.ts) · [durable/test/examples/30-reload-and-restart.ts](https://github.com/earendil-works/pi/blob/56cae782341c339d3bb820081f0f9425d8c5b1ec/packages/durable/test/examples/30-reload-and-restart.ts)

验收时先根据正文逐箭头复述状态，再改变该章 Q&A 中一个条件，核对答案。任何需依靠正文纠正的图中错误均应修图。

## 通用视觉提示

生成精细中文技术教材架构图，横向3:2，奶白纸面、墨蓝紧凑标题、蓝调用青返回紫状态，清晰中文无衬线，主体占85%，细线框、正交箭头，真实结构关系，禁止卡片堆砌、厚重3D、口号、整段小字，文字仅按指定内容，不擅加字段或保证。主题及对象连线如下。

## 定向返工的要求

03.1 删除了消息和事件上的虚构身份字段；05.1 删除了错误接线；05.2 用空数组明确贡献；06.2 删除了自动编造的摘要正文；06.3 标清压缩后重建；07.1 补回正常工具续轮；07.2 把队列移出工具批次；11.2 限定立即存储提交；13.1 使用实际检查点字段；13.3 只有成功提交新状态才重开计数；14.1 区分结果与交付日志；14.2 校正先记录后交付；15.1 错误结果沿结果路径返回。
## 06.4 预算与合法切点

教学输入为 U1=100、A1=200、R1=800、A2=100、U2=100、A3=100 token，keepRecentTokens=500。倒数累计到R1达到1100，但R1不可切，选A2。保留原文300，前缀U1/A1/R1单独摘要。数字为教学估计，源码由findProjectedCutPoint与prepareCompaction决定。

## 06.5 三种压缩入口

对象为手动运行、请求前阈值检查和overflow恢复。手动先abort；阈值重取投影供下一请求；overflow先首次恢复保护，再持久省略失败尝试，再执行压缩，失败不沿该恢复自动续请求。默认摘要拒绝error/length/toolCall；扩展可取消或提供结果，请求前阈值压缩失败仍可能继续。



