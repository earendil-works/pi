# 本变更原则

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
