// Signing in to a model provider (`SignIn`, one object per person; the owner only until workspaces decide who may make
// a login): the person's page starts a sign-in, the provider's own flow (pi-ai: OAuth, or an API key) runs here on the
// server, asks its questions and tells its steps through the person's attempt, and a finished one's credential waits
// in the person's `SignIns` object, in memory, for the create step that hands its attempt id over (`adopt`): one per
// person, dropped by the next start, a cancel, its time running out, or the object's end (a reload, the person's last
// page gone). Server code holds a credential the same way for a login it makes (`hold`).

import {
	type AuthEvent,
	type AuthPrompt,
	admitOwner,
	BACKGROUND_CONTEXT,
	type Credential,
	type Ctx,
	callerKey,
	type FacetHost,
	invalid,
	type P3Principal,
	type Provider,
	type Reference,
	reportError,
	sleep,
	untilAborted,
} from "@earendil-works/p3/v1";
import { ThingsStore } from "../things/contract.server.ts";
import { type Source, sourceKey } from "../things/contract.ts";
import { LoginStore, SignIns } from "./contract.server.ts";
import type { Attempt } from "./contract.ts";
import { type Notice, type Prompt, type ProviderChoice, SignIn, type SignInMethod } from "./contract.ts";
import { LoginKind } from "./kind.ts";
import { LoginProviders } from "./login-providers.ts";
import { messages } from "./messages.ts";
import { nameOf } from "./store.ts";
import { Turns } from "./turns.ts";

/** How long a sign-in may take before it ends. */
const DEADLINE_MS = 10 * 60_000;

/**
 * How long a finished sign-in's credential waits for its login, and how long a person's object outlives their last
 * page (a phone's page loses its socket while its person is at the provider's page).
 */
const KEPT_MS = 15 * 60_000;

/** How long a new start waits for the flow it replaces to end (a provider's flow may ignore its abort). */
const REPLACE_MS = 5_000;

/** A finished sign-in's credential, waiting, and the timer that drops it. */
type Held = {
	readonly provider: string;
	readonly credential: Credential;
	readonly timer: ReturnType<typeof setTimeout>;
};

/** Serves `SignIns` and `SignIn` on `host`. */
export function serveSignIn(host: FacetHost<P3Principal>): void {
	// One object per person (its params): what it holds is theirs alone.
	host.serve(
		SignIns,
		(_params, self) => {
			const providers = self.registry(LoginProviders);
			const store = self.get(LoginStore, {});
			const things = self.get(ThingsStore, {});
			const attempt = self.writable<Attempt | null>(null);
			const held = new Map<string, Held>();
			const turns = new Turns();
			let current: Running | undefined;
			/** Set as the object ends, before its flows abort: nothing is shown after its state ended. */
			let closed = false;
			const lifetime = new AbortController();
			/** The object's own context while it is live: what a flow writes to the store under, after `start` answered. */
			const live = Promise.withResolvers<Ctx<P3Principal>>();
			self.onLive(async (ctx) => {
				live.resolve(ctx);
				await untilAborted(ctx).finally(() => {
					closed = true;
					lifetime.abort();
					for (const { timer } of held.values()) clearTimeout(timer);
					held.clear();
				});
			});
			const show = (next: Attempt | null) => {
				if (!closed) attempt.set(next);
			};
			const drop = (id: string) => {
				clearTimeout(held.get(id)?.timer);
				held.delete(id);
				if (attempt.value?.attempt === id) show(null);
			};
			const keep = (id: string, provider: string, credential: Credential) => {
				held.set(id, { provider, credential, timer: setTimeout(() => drop(id), KEPT_MS) });
			};
			/** Ends the current flow, and drops the credential the person's last sign-in left waiting. */
			const replace = async () => {
				const previous = current;
				previous?.end();
				if (previous !== undefined) await Promise.race([previous.done, sleep(REPLACE_MS, BACKGROUND_CONTEXT)]);
				const shown = attempt.value;
				if (shown !== null) drop(shown.attempt);
			};
			return {
				attempt: self.derive([attempt], ([value]) => value),
				start: ({ provider: id, method }) =>
					turns.run("moves", async () => {
						const provider = providers.value.get(id)?.value;
						if (provider === undefined || !offers(provider, method)) {
							throw invalid("args", `providers: ${id} offers no sign-in by ${method}`);
						}
						await replace();
						const flow = new Running(crypto.randomUUID(), lifetime.signal);
						current = flow;
						let state: Attempt = {
							status: "working",
							attempt: flow.attempt,
							provider: id,
							method,
							prompt: null,
							notices: [],
						};
						const update = (next: Attempt) => {
							state = next;
							if (current === flow) show(next);
						};
						const ask = (prompt: Prompt | null) => {
							if (state.status === "working") update({ ...state, prompt });
						};
						update(state);
						flow.done = (async () => {
							const ctx = await live.promise;
							try {
								const credential = await signIn(provider, method, flow, {
									prompt: ask,
									answered: () => ask(null),
									notice: (notice) => update({ ...state, notices: [...state.notices, notice] }),
									deviceId: () => store.device({}, ctx),
								});
								// A flow ended meanwhile keeps nothing: after the object's end nothing would ever drop it.
								if (flow.signal.aborted) return;
								keep(flow.attempt, id, credential);
								update({ status: "done", attempt: flow.attempt, provider: id, method, notices: state.notices });
							} catch (error) {
								const why = flow.why();
								// Replaced or cancelled: nothing of it is shown any more (the next start or the cancel drops it).
								if (why === "ended") return;
								if (why === "failed") reportError(`providers: a sign-in to ${id} failed`, nameOf(error), ctx);
								update({
									status: "ended",
									attempt: flow.attempt,
									provider: id,
									method,
									message: messages.message(why),
									notices: state.notices,
								});
							} finally {
								flow.close();
								if (current === flow) current = undefined;
							}
						})();
						return flow.attempt;
					}),
				answer: async ({ prompt, value }) => {
					if (current === undefined) throw invalid("args", "providers: no sign-in is running");
					current.answer(prompt, value);
					return null;
				},
				cancel: ({ attempt: id }) =>
					turns.run("moves", async () => {
						if (current?.attempt === id) {
							current.end();
							await current.done;
						}
						drop(id);
						return null;
					}),
				hold: async ({ provider, credential }) => {
					const id = crypto.randomUUID();
					// Server code of this plugin hands pi-ai's credentials only.
					keep(id, provider, credential as Credential);
					return id;
				},
				adopt: ({ attempt: id, thing }, ctx) =>
					turns.run("moves", async () => {
						const found = held.get(id);
						if (found === undefined)
							throw invalid("args", "providers: no such sign-in of yours (used or expired)");
						await store.create({ thing, provider: found.provider, credential: found.credential }, ctx);
						drop(id);
						return null;
					}),
				// Its own turn: the login it makes is adopted in the turn of the moves.
				ensure: ({ name, workspace, by, provider, credential }, ctx) =>
					turns.run("ensure", async () => {
						const found = await madeThere(things, { name, workspace, by }, ctx);
						if (found !== undefined) return found;
						const attempt = crypto.randomUUID();
						// Server code of this plugin hands pi-ai's credentials only.
						keep(attempt, provider, credential as Credential);
						return things.create({ kind: LoginKind.name, name, workspace, by, input: { attempt } }, ctx);
					}),
			};
		},
		{ linger: KEPT_MS },
	);

	host.serve(
		SignIn,
		(_params, principal, _admitted, self) => {
			const flows = self.get(SignIns, { owner: callerKey(principal) });
			const providers = self.registry(LoginProviders);
			return {
				providers: self.derive([providers], ([offered]) =>
					choices([...offered.values()].map(({ value }) => value)),
				),
				attempt: flows.attempt,
				start: (args: { provider: string; method: SignInMethod }, ctx: Ctx<P3Principal>) => flows.start(args, ctx),
				answer: (args: { prompt: string; value: string }, ctx: Ctx<P3Principal>) => flows.answer(args, ctx),
				cancel: (args: { attempt: string }, ctx: Ctx<P3Principal>) => flows.cancel(args, ctx),
			};
		},
		{ admit: admitOwner },
	);
}

/**
 * The login named `name` that `by` made, linked in `workspace` (its maker is stored with the thing: a person's login
 * of the same name is never taken for it), if there is one. A workspace holds few logins: its links are read whole.
 */
async function madeThere(
	things: Reference<typeof ThingsStore>,
	{ name, workspace, by }: { readonly name: string; readonly workspace: string; readonly by: Source },
	ctx: Ctx<P3Principal>,
): Promise<string | undefined> {
	const maker = sourceKey(by);
	for (let page = await things.links.here.page({ workspace }, 100, ctx); ; ) {
		for (const { thing, of } of page.items) {
			if (of !== LoginKind.name) continue;
			const [row] = (await things.things.one.page({ thing }, 1, ctx)).items;
			if (row?.name === name && sourceKey(row.madeBy) === maker) return thing;
		}
		if (page.next === undefined) return undefined;
		page = await things.links.here.page({ workspace }, 100, ctx, { after: page.next });
	}
}

/** What a flow tells its attempt, and the device id some providers sign in with. */
type Reports = {
	readonly prompt: (prompt: Prompt) => void;
	readonly answered: () => void;
	readonly notice: (notice: Notice) => void;
	readonly deviceId: () => Promise<string>;
};

/** Why a flow ended: replaced or cancelled, or (a message key, as the person reads it) the rest. */
type Ending = "ended" | "failed" | "expired" | "stopped";

/** One running sign-in: its deadline, how it ends and why, and its open question. */
class Running {
	readonly attempt: string;
	readonly signal: AbortSignal;
	done: Promise<void> = Promise.resolve();
	readonly #lifetime: AbortSignal;
	readonly #controller = new AbortController();
	readonly #deadline: ReturnType<typeof setTimeout>;
	#expired = false;
	#ended = false;
	#question: { readonly prompt: Prompt; readonly resolve: (value: string) => void } | undefined;

	constructor(attempt: string, lifetime: AbortSignal) {
		this.attempt = attempt;
		this.#lifetime = lifetime;
		this.signal = AbortSignal.any([lifetime, this.#controller.signal]);
		this.#deadline = setTimeout(() => {
			this.#expired = true;
			this.#controller.abort();
		}, DEADLINE_MS);
		// A provider's flow may ignore its abort and never end: its deadline goes with the abort, not with the flow.
		this.signal.addEventListener("abort", () => clearTimeout(this.#deadline), { once: true });
	}

	/** Ends the flow (replaced or cancelled: nothing of it is shown any more). */
	end(): void {
		this.#ended = true;
		this.#controller.abort();
	}

	/** Asks `prompt`; resolves with the person's answer, rejects when the flow or the prompt ends first. */
	ask(input: AuthPrompt, reports: Reports): Promise<string> {
		const signal = input.signal === undefined ? this.signal : AbortSignal.any([this.signal, input.signal]);
		const prompt = promptOf(input);
		return new Promise<string>((resolve, reject) => {
			if (signal.aborted) return reject(signal.reason);
			const abort = () => {
				reject(signal.reason);
				if (this.#question?.prompt !== prompt) return;
				this.#question = undefined;
				reports.answered();
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

	/** Why the flow ended: replaced or cancelled, its deadline, the object's end, or the provider's flow failing. */
	why(): Ending {
		if (this.#ended) return "ended";
		if (this.#expired) return "expired";
		return this.#lifetime.aborted ? "stopped" : "failed";
	}

	/** Withdraws what the flow left open (a manual-code question raced by a callback that won) and its deadline. */
	close(): void {
		clearTimeout(this.#deadline);
		this.#controller.abort();
	}
}

/** The provider's own sign-in by `method`: its credential. */
async function signIn(provider: Provider, method: SignInMethod, flow: Running, reports: Reports): Promise<Credential> {
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
function offers(provider: Provider, method: SignInMethod): boolean {
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
