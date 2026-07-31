import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

/** 文件变更队列的内部状态：每个规范路径对应一个 Promise 链。 */
type MutationQueueState = {
	queues: Map<string, Promise<void>>;
	registration: Promise<void>;
};

/** 每个 ExecutionEnv 实例维护独立的变更队列，通过 WeakMap 关联。 */
const states = new WeakMap<ExecutionEnv, MutationQueueState>();

/** 获取或创建指定 ExecutionEnv 的变更队列状态。 */
function getState(env: ExecutionEnv): MutationQueueState {
	let state = states.get(env);
	if (!state) {
		state = { queues: new Map(), registration: Promise.resolve() };
		states.set(env, state);
	}
	return state;
}

/** 解析文件的规范路径作为队列 key，优先使用 canonical path，降级使用绝对路径。 */
async function getMutationQueueKey(env: ExecutionEnv, path: string): Promise<string> {
	const absolutePath = getOrThrow(await env.absolutePath(path));
	const canonicalPath = await env.canonicalPath(absolutePath);
	if (canonicalPath.ok) return canonicalPath.value;
	if (canonicalPath.error.code === "not_found" || canonicalPath.error.code === "not_supported") return absolutePath;
	throw canonicalPath.error;
}

/**
 * 对同一 ExecutionEnv 和规范路径下的文件变更进行序列化。
 * 确保对同一文件的并发写入/编辑按顺序执行，避免竞态条件。
 */
export async function withFileMutationQueue<T>(env: ExecutionEnv, path: string, fn: () => Promise<T>): Promise<T> {
	const state = getState(env);
	const registration = state.registration.then(async () => {
		const key = await getMutationQueueKey(env, path);
		const currentQueue = state.queues.get(key) ?? Promise.resolve();

		let releaseNext = () => {};
		const nextQueue = new Promise<void>((resolve) => {
			releaseNext = resolve;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		state.queues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	state.registration = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (state.queues.get(key) === chainedQueue) state.queues.delete(key);
	}
}
