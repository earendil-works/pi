import type { ExecutionEnv } from "../types.ts";

/** 内置执行工具所需的文件系统和 shell 上下文。 */
export interface ExecutionToolContext {
	env: ExecutionEnv;
}
