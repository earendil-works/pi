import type { Context } from "@earendil-works/chord";
import {
	createModels,
	type FauxProviderHandle,
	type FauxResponseStep,
	fauxProvider,
	type Message,
	type Models,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	type EntryRecord,
	Harness,
	type HarnessOptions,
	type HarnessSettings,
	type Registry,
	type Storage,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "../src/env/index.ts";
import { context } from "./session-support.ts";

/** Models and registry that survive a close/reopen, like a host process's own objects. */
export type ChatSetup = {
	readonly faux: FauxProviderHandle;
	readonly models: Models;
	readonly registry: Registry;
	readonly reports: unknown[];
	/** Live Harness settings; tests assign fields to change them between decisions. */
	readonly settings: { -readonly [K in keyof HarnessSettings]: HarnessSettings[K] };
	now: () => number;
};

export function chatSetup(options: RegisterFauxProviderOptions = {}): ChatSetup {
	const faux = fauxProvider(options);
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, models, registry: createRegistry(), reports: [], settings: {}, now: () => Date.now() };
}

/** Open a Harness over `storage` and return its root, configured with the faux model on first creation. */
export async function openChat(
	storage: Storage,
	setup: ChatSetup,
	/** One environment for every conversation, or an `env` function. */
	options: { readonly env?: ExecutionEnv | NonNullable<HarnessOptions["env"]> } = {},
): Promise<{ readonly harness: Harness; readonly root: Conversation }> {
	const harness = await Harness.open(
		storage,
		{
			models: setup.models,
			registry: setup.registry,
			settings: setup.settings,
			...(options.env === undefined
				? {}
				: { env: typeof options.env === "function" ? options.env : () => options.env as ExecutionEnv }),
			now: () => setup.now(),
			onReport: (error) => setup.reports.push(error),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	return { harness, root };
}

/** Raw entries of a conversation, oldest first. */
export async function allEntries(conversation: Conversation, callContext: Context = context): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, callContext);
	return [...page.items].reverse();
}

/** Text of the first text content of a message. */
export function textOf(message: Message | undefined): string | undefined {
	if (message === undefined) return undefined;
	if (message.role === "system") return undefined;
	if (typeof message.content === "string") return message.content;
	const text = message.content.find((content) => content.type === "text");
	return text?.type === "text" ? text.text : undefined;
}

/** Poll `check` in real time until it holds; for waits that span throttle windows and timers. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Condition was not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * Faux response that never answers; the run stays busy until its generation is cancelled. `reached` resolves once the
 * request was sent, after the generation's preparation and request commits.
 */
export function unanswered(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	const step: FauxResponseStep = (_context, options) =>
		new Promise((_, reject) => {
			reach();
			const signal = options!.signal!;
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	return { step, reached };
}

/** The installed tools with these names, as `configure()` takes them. */
export function toolsNamed(setup: ChatSetup, ...names: string[]): ToolRegistration[] {
	const installed = setup.registry.snapshot().tools();
	return names.map((name) => {
		const found = installed.find(({ tool }) => tool.name === name);
		if (found === undefined) throw new Error(`Tool ${name} is not installed`);
		return found.tool;
	});
}
