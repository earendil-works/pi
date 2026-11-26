// Signing in to a model provider (`SignIn`, one object per person): the person's page starts a sign-in, the provider's
// own flow (pi-ai: OAuth, or an API key) runs here on the server, asks its questions and tells its steps through the
// person's attempt, and a finished one's credential is kept by the store under a sign-in id bound to the person, for
// the create step (or a sign-in again) that hands that id over. The flows run in one host-lifetime object
// (`SignIns`): one per person at a time; a reload of the plugin ends the running ones (the person starts again).

import {
	type Ctx,
	callerKey,
	type FacetHost,
	forbidden,
	invalid,
	local,
	type MessageData,
	map,
	method,
	obj,
	type P3Principal,
	str,
	untilAborted,
} from "@earendil-works/p3/v1";
import type { AuthEvent, AuthPrompt, Credential, Provider } from "@earendil-works/p3/v1/server";
import { LoginStore } from "./contract.server.ts";
import { Attempt, Method, type Notice, type Prompt, type ProviderChoice, SignIn } from "./contract.ts";
import { LoginProviders } from "./login-providers.ts";
import { messages } from "./messages.ts";

/** Every person's sign-in, by their `callerKey`, and the moves on them: server code of this plugin only. */
const SignIns = local("providers.sign-ins", {
	version: 1,
	params: {},
	members: {
		attempts: map(Attempt),
		start: method(obj({ owner: str(), provider: str(), method: Method }), str()),
		answer: method(obj({ owner: str(), attempt: str(), prompt: str(), value: str() })),
		cancel: method(obj({ owner: str(), attempt: str() })),
	},
});

/** How long a sign-in may take before it ends. */
const DEADLINE_MS = 10 * 60_000;

/** The longest provider error text a failed sign-in shows. */
const ERROR_TEXT = 300;

/** Serves `SignIns` and `SignIn` on `host`. */
export function serveSignIn(host: FacetHost<P3Principal>): void {
	host.serve(SignIns, (_params, self) => {
		const providers = self.registry(LoginProviders);
		const store = self.get(LoginStore, {});
		const attempts = self.writable<Readonly<Record<string, Attempt>>>({});
		/** The running flows, by person (`callerKey`): their attempt id, how to end them, their open questions. */
		const running = new Map<string, Running>();
		/** Ends the flows with the object (a reload, the server's stop). */
		const lifetime = new AbortController();
		/** The object's own context while it is live: what a flow writes to the store under, after `start` answered. */
		const live = Promise.withResolvers<Ctx<P3Principal>>();
		self.onLive(async (ctx) => {
			live.resolve(ctx);
			await untilAborted(ctx).finally(() => lifetime.abort());
		});
		const show = (owner: string, next: Attempt | undefined) => {
			const { [owner]: _gone, ...others } = attempts.value;
			attempts.set(next === undefined ? others : { ...others, [owner]: next });
		};
		const ofAttempt = (owner: string, attempt: string): Running => {
			const found = running.get(owner);
			if (found === undefined || found.attempt !== attempt) {
				throw invalid("args", "providers: that sign-in is no longer running");
			}
			return found;
		};
		return {
			attempts: self.derive([attempts], ([value]) => value),
			start: async ({ owner, provider: id, method }) => {
				const provider = providers.value.get(id)?.value;
				if (provider === undefined || !offers(provider, method)) {
					throw invalid("args", `providers: ${id} offers no sign-in by ${method}`);
				}
				const previous = running.get(owner);
				if (previous !== undefined) {
					previous.end(messages.message("replaced"));
					await previous.done;
				}
				const attempt = crypto.randomUUID();
				const flow = new Running(attempt, AbortSignal.any([lifetime.signal, AbortSignal.timeout(DEADLINE_MS)]));
				running.set(owner, flow);
				let state: Attempt = { status: "working", attempt, provider: id, method, prompt: null, notices: [] };
				const update = (next: Attempt) => {
					state = next;
					if (running.get(owner) === flow) show(owner, next);
				};
				update(state);
				const ask = (prompt: Prompt | null) => {
					if (state.status === "working") update({ ...state, prompt });
				};
				flow.done = (async () => {
					const ctx = await live.promise;
					try {
						const credential = await signIn(provider, method, flow, {
							prompt: ask,
							answered: () => ask(null),
							notice: (notice) => update({ ...state, notices: [...state.notices, notice] }),
							deviceId: () => store.device({}, ctx),
						});
						const signInId = await store.keep({ owner, provider: id, method, credential }, ctx);
						update({ status: "done", attempt, provider: id, method, signIn: signInId, notices: state.notices });
					} catch (error) {
						update({
							status: "ended",
							attempt,
							provider: id,
							method,
							message: flow.why(error),
							notices: state.notices,
						});
					} finally {
						flow.close();
						if (running.get(owner) === flow) running.delete(owner);
					}
				})();
				return attempt;
			},
			answer: async ({ owner, attempt, prompt, value }) => {
				ofAttempt(owner, attempt).answer(prompt, value);
				return null;
			},
			cancel: async ({ owner, attempt }, ctx) => {
				const found = running.get(owner);
				if (found?.attempt === attempt) {
					found.end(messages.message("cancelled"));
					await found.done;
				}
				const shown = attempts.value[owner];
				if (shown?.attempt !== attempt) return null;
				if (shown.status === "done") await store.drop({ owner, signIn: shown.signIn }, ctx);
				show(owner, undefined);
				return null;
			},
		};
	});

	host.serve(SignIn, (_params, principal, self) => {
		if (principal.kind !== "person") throw forbidden("providers: people sign in, nobody else");
		const owner = callerKey(principal);
		const flows = self.get(SignIns, {});
		const providers = self.registry(LoginProviders);
		return {
			providers: self.derive([providers], ([offered]) => choices([...offered.values()].map(({ value }) => value))),
			attempt: self.derive([flows.attempts], ([all]) => all[owner] ?? null),
			start: (args: { provider: string; method: Method }, ctx: Ctx<P3Principal>) =>
				flows.start({ owner, ...args }, ctx),
			answer: (args: { attempt: string; prompt: string; value: string }, ctx: Ctx<P3Principal>) =>
				flows.answer({ owner, ...args }, ctx),
			cancel: (args: { attempt: string }, ctx: Ctx<P3Principal>) => flows.cancel({ owner, ...args }, ctx),
		};
	});
}

/** What a flow tells its attempt, and the device id some providers sign in with. */
type Reports = {
	readonly prompt: (prompt: Prompt) => void;
	readonly answered: () => void;
	readonly notice: (notice: Notice) => void;
	readonly deviceId: () => Promise<string>;
};

/** One running sign-in: how it ends and why, and its open question. */
class Running {
	readonly attempt: string;
	readonly signal: AbortSignal;
	done: Promise<void> = Promise.resolve();
	readonly #controller = new AbortController();
	#ending: MessageData | undefined;
	#question: { readonly prompt: Prompt; readonly resolve: (value: string) => void } | undefined;

	readonly #outer: AbortSignal;

	constructor(attempt: string, outer: AbortSignal) {
		this.attempt = attempt;
		this.#outer = outer;
		this.signal = AbortSignal.any([outer, this.#controller.signal]);
	}

	/** Ends the flow, for `why` (the first ending is the one it shows). */
	end(why: MessageData): void {
		this.#ending ??= why;
		this.#controller.abort();
	}

	/** Asks `prompt`; resolves with the person's answer, rejects when the flow or the prompt ends first. */
	ask(input: AuthPrompt, reports: Reports): Promise<string> {
		const signal = input.signal === undefined ? this.signal : AbortSignal.any([this.signal, input.signal]);
		const prompt = promptOf(input);
		return new Promise<string>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			const abort = () => {
				if (this.#question?.prompt === prompt) {
					this.#question = undefined;
					reports.answered();
				}
				reject(signal.reason);
			};
			signal.addEventListener("abort", abort, { once: true });
			this.#question = {
				prompt,
				resolve: (value) => {
					signal.removeEventListener("abort", abort);
					this.#question = undefined;
					reports.answered();
					resolve(value);
				},
			};
			reports.prompt(prompt);
		});
	}

	/** Answers the open question `prompt` (a select only with one of its options). */
	answer(prompt: string, value: string): void {
		const question = this.#question;
		if (question === undefined || question.prompt.id !== prompt) {
			throw invalid("args", "providers: that question is no longer asked");
		}
		if (question.prompt.type === "select" && !question.prompt.options.some((option) => option.id === value)) {
			throw invalid("args", "providers: pick one of the options");
		}
		question.resolve(value);
	}

	/** Why the flow ended with `error`, as the person reads it. */
	why(error: unknown): MessageData {
		if (this.#ending !== undefined) return this.#ending;
		if (this.#outer.aborted) {
			return this.#outer.reason instanceof DOMException && this.#outer.reason.name === "TimeoutError"
				? messages.message("expired")
				: messages.message("stopped");
		}
		const text = error instanceof Error ? error.message : String(error);
		return messages.message("failed", text.slice(0, ERROR_TEXT));
	}

	/** Withdraws what the flow left open (a manual-code question raced by a callback that won). */
	close(): void {
		this.#controller.abort();
	}
}

/** The provider's own sign-in by `method`: its credential. */
async function signIn(provider: Provider, method: Method, flow: Running, reports: Reports): Promise<Credential> {
	const interaction = {
		signal: flow.signal,
		prompt: (prompt: AuthPrompt) => flow.ask(prompt, reports),
		notify: (event: AuthEvent) => {
			if (!flow.signal.aborted) reports.notice(noticeOf(event));
		},
	};
	if (method === "oauth") {
		// `start` checked that the provider offers it.
		const deviceId = await reports.deviceId();
		return provider.auth.oauth!.login(interaction, { getDeviceId: () => deviceId });
	}
	return provider.auth.apiKey!.login!(interaction);
}

/** Whether `provider` offers a sign-in by `method`. */
function offers(provider: Provider, method: Method): boolean {
	return method === "oauth" ? provider.auth.oauth !== undefined : provider.auth.apiKey?.login !== undefined;
}

/** The providers people may sign in to, with how, in name order; those with no sign-in left out. */
function choices(providers: readonly Provider[]): ProviderChoice[] {
	return providers
		.map(({ id, name, auth }) => ({
			id,
			name,
			methods: [
				...(auth.oauth === undefined
					? []
					: [{ method: "oauth" as const, label: auth.oauth.loginLabel ?? auth.oauth.name }]),
				...(auth.apiKey?.login === undefined ? [] : [{ method: "api_key" as const, label: auth.apiKey.name }]),
			],
		}))
		.filter(({ methods }) => methods.length > 0)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** pi-ai's question as the contract carries it: an id, without its signal, absent fields left out. */
function promptOf(input: AuthPrompt): Prompt {
	const id = crypto.randomUUID();
	if (input.type === "select") {
		return {
			id,
			type: "select",
			message: input.message,
			options: input.options.map(({ id: option, label, description }) => ({
				id: option,
				label,
				...(description === undefined ? {} : { description }),
			})),
		};
	}
	return {
		id,
		type: input.type,
		message: input.message,
		...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
	};
}

/** pi-ai's step as the contract carries it, absent fields left out. */
function noticeOf(event: AuthEvent): Notice {
	switch (event.type) {
		case "info":
			return {
				type: "info",
				message: event.message,
				...(event.links === undefined
					? {}
					: {
							links: event.links.map(({ url, label }) => ({ url, ...(label === undefined ? {} : { label }) })),
						}),
			};
		case "auth_url":
			return {
				type: "auth_url",
				url: event.url,
				...(event.instructions === undefined ? {} : { instructions: event.instructions }),
			};
		case "device_code":
			return {
				type: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
				...(event.intervalSeconds === undefined ? {} : { intervalSeconds: event.intervalSeconds }),
				...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds }),
			};
		case "progress":
			return { type: "progress", message: event.message };
	}
}
