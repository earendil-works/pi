import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

type MutationQueueState = {
	queues: Map<string, Promise<void>>;
	registration: Promise<void>;
};

const states = new WeakMap<ExecutionEnv, MutationQueueState>();

function getState(env: ExecutionEnv): MutationQueueState {
	let state = states.get(env);
	if (!state) {
		state = { queues: new Map(), registration: Promise.resolve() };
		states.set(env, state);
	}
	return state;
}

async function getMutationQueueKey(env: ExecutionEnv, path: string): Promise<string> {
	const absolutePath = getOrThrow(await env.absolutePath(path));
	const canonicalPath = await env.canonicalPath(absolutePath);
	if (canonicalPath.ok) return canonicalPath.value;
	if (canonicalPath.error.code === "not_found" || canonicalPath.error.code === "not_supported") return absolutePath;
	throw canonicalPath.error;
}

/** Serialize file mutations targeting the same environment and canonical path. */
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
