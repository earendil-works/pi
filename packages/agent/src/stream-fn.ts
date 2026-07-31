import type { StreamFn } from "./types.ts";

/** 默认的 stream 函数实例，由宿主通过 setDefaultStreamFn 配置。 */
let defaultStreamFn: StreamFn | undefined;

/**
 * 配置 Agent 和底层 loop 在调用方省略 streamFn 时使用的兜底 stream 函数。
 * 提供默认模型运行时的宿主可以在此安装其 stream 函数，
 * 无需让 pi-agent-core 依赖 provider 目录或兼容层。
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

/** 获取默认 stream 函数，未配置时抛出错误。 */
export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
