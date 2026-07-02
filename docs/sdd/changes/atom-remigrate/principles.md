# 本变更原则

- 迁移不可逆操作必须有备份,出错可手动 cp 回滚。
- LLM 输出需逐批校验,失败 batch 不影响后续 batch。
- id 是 stable anchor,所有 in-place 改必须保留 id,version+1 即可。
- bge-m3 向量跟文本强一致,文本改完必须 reindex,失败要 warn 不中断。
- 召回策略改动不在本变更范围,改 atom 文本是唯一信号源。
- 合并 cluster 判定完全交给 LLM,程序只做执行不参与语义判断。
- 旧 atom 的 source_session 几乎全 null,本变更不尝试回填 (那是另一个 change)。
