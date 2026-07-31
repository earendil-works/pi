/**
 * Node.js 入口：导出 NodeExecutionEnv 以及所有公共 API。
 *
 * 使用此入口的应用运行在 Node.js 环境下，获得基于 Node.js fs/spawn 的文件系统和 shell 能力。
 */
export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
export * from "./index.ts";
