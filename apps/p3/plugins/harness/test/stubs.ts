// Stand-ins for the plugin tier of the harness (and the transcript) on a session's worker: on a stand-in server, its
// `SessionFacts` (a row the test changes, and the reports it records) and `MyAnswer` (each caller's ticks on the
// session, as the test sets them); on the worker, this device's machine (`test.device`, a part that gives the
// environment of a location on machine `this-device`, held always), the holding (`HeldThings`: what the test says the agent holds, an unchanged kind's list kept by
// identity) and a scripted login's kind (`test.login`: a pi-ai faux provider per thing answering from its script,
// each request recorded, and with `tool` the tool `test_session`, which reads the session's folder through the
// session's `call`). The real things plugin's worker facet (the registries) and the tools plugin's (the coding tools'
// part) load beside them, imported as modules.

import {
	arr,
	bool,
	constant,
	contribute,
	defineFacet,
	defineMessages,
	lit,
	MyAnswer,
	obj,
	type P3Principal,
	type PluginFacet,
	type SessionDetail,
	SessionFacts,
	SessionKind,
	type SessionRow,
	type SessionState,
	type Static,
	str,
	union,
	type Writable,
} from "@earendil-works/p3/v1";
import {
	defineTool,
	type ExecutionEnv,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	NodeExecutionEnv,
	section,
} from "@earendil-works/p3/v1/worker";
import {
	type HarnessLocation,
	type HarnessSession,
	type Held,
	type HeldThing,
	HeldThings,
	ThingHarnessParts,
	thingHarnessPart,
} from "../../things/contract.worker.ts";
import { defineThing } from "../../things/kind.ts";
import { held as heldThing } from "../../things/test/part.ts";
import things from "../../things/worker.ts";
import { CodingToolsKind } from "../../tools/kind.ts";
import tools from "../../tools/worker.ts";
import { SubagentsKind } from "../kind.ts";

/** One part of a scripted answer: text, or a tool call (its arguments as JSON text). */
const Reply = union([obj({ kind: lit("text"), text: str() }), obj({ kind: lit("tool"), name: str(), args: str() })]);

/** A scripted answer: given to the first request whose last message (a person's text, a tool result) contains `when`. */
const Step = obj({ when: str(), reply: arr(Reply) });

/** A scripted answer (see `Step`). */
export type Step = Static<typeof Step>;

/** The stand-ins' tick labels. */
const messages = defineMessages("test", { en: { use: "Use" } });

/**
 * A scripted login: its provider's id (its one model is `<provider>-model`; none with an empty script: a login whose
 * models are all hidden), its script, and the tool `test_session`.
 */
const LoginKind = defineThing("test.login", {
	version: 1,
	state: { provider: str(), script: arr(Step), tool: bool() },
	ticks: { use: { label: messages.message("use"), for: "agents" } },
});

/** A request a scripted login received: its provider, the last message's text, the tools offered, the system prompt. */
export type Request = {
	provider: string;
	last: string;
	tools: string[];
	prompt: string;
	/** The tools the request's last change of tools took away (none: no change). */
	removed: string[];
};

/** A thing the agent holds, as the test makes it: its kind's name and the held entry. */
export type Holding = { readonly kind: string; readonly held: HeldThing };

/** What the test drives the stand-ins with. */
export type Server = {
	/** The reports the worker made, in order. */
	readonly reports: SessionState[];
	/** What the scripted logins received, in order. */
	readonly requests: Request[];
	/** How often each kind's part was called (by kind name). */
	readonly given: Map<string, number>;
	/** Sets the session's row (as the server's store would change it). */
	row(change: Partial<SessionRow>): void;
	/** The conversations moved, by id (`SessionFacts.detail`, as `moveLocation` set them). */
	readonly moved: () => SessionDetail["locations"];
	/** Makes the next undo of a move fail (the server away for one call). */
	failNextUndo(): void;
	/**
	 * Sets what the agent holds (and makes the holding ready); a kind whose entries are the same objects in the same
	 * order keeps its list.
	 */
	hold(things: readonly Holding[]): void;
	/** Sets a caller's ticks on the session by key (`person:<id>`); `null` (and unset): given nothing. */
	ticks(caller: string, ticks: readonly string[] | null, kind?: string): void;
	/** Makes the next reports wait until `release` resolves (a slow server). */
	slow(release: Promise<void>): void;
	/** Makes the logins' `ready` wait until `complete` resolves (their models still loading). */
	loading(complete: Promise<void>): void;
	/** How often the logins' `ready` was asked. */
	readonly readies: number;
};

/** This device's machine kind, as the stand-ins have it. */
const DeviceKind = defineThing("test.device", { version: 1, ticks: {} });

/** This device's machine, held always (beside what a case holds). */
const DEVICE: Holding = { kind: DeviceKind.name, held: heldThing("this-device", []) };

/** A session row of `id` working in `folder`. */
export function sessionRow(id: string, folder: string): SessionRow {
	return {
		id,
		location: { machine: "this-device", folder },
		createdAt: 1,
		state: "settled",
		lastTouch: 1,
		archivedAt: null,
		model: null,
	};
}

/** A held scripted login `thing` of provider `provider` answering from `script`, with `test_session` if `tool`. */
export function login(thing: string, provider: string, script: Step[], tool = false): Holding {
	const members = { provider: constant(provider), script: constant(script), tool: constant(tool) };
	return { kind: LoginKind.name, held: heldThing(thing, ["use"], members) };
}

/** A held coding tools thing with the flags `granted` (all four by default). */
export function coding(thing = "tools", granted = ["read", "write", "edit", "bash"]): Holding {
	return { kind: CodingToolsKind.name, held: heldThing(thing, granted) };
}

/** A held subagents thing, with the flag `use` unless withheld. */
export function subagents(use = true): Holding {
	return { kind: SubagentsKind.name, held: heldThing("subagents", use ? ["use"] : []) };
}

/** A held thing of `kind`, whose part (`extra`) gives what the case needs. */
export function other(kind: string, thing: string): Holding {
	return { kind, held: heldThing(thing, []) };
}

/** A part a case adds beside the others: the kind's name, and what it gives (a prompt section, an environment). */
export type Extra = {
	readonly kind: string;
	readonly prompt?: string;
	readonly env?: (location: HarnessLocation) => ExecutionEnv | undefined;
	/** Gets the session the part is called with. */
	readonly seen?: (session: HarnessSession) => void;
};

/** The stand-ins (plus the things and tools plugins) for session `row.id`, the extra parts, and the controls. */
export function standIns(
	row: SessionRow,
	held: readonly Holding[],
	extras: readonly Extra[] = [],
	{ ready = true }: { readonly ready?: boolean } = {},
): { stubs: PluginFacet<P3Principal>[]; server: PluginFacet<P3Principal>[]; control: Server } {
	let rowValue = row;
	let grouped = group([...held, DEVICE], new Map());
	// Not ready: the holding contributes `undefined` until the test holds something.
	let heldValue: Held | undefined = ready ? grouped : undefined;
	let release: Promise<void> = Promise.resolve();
	let complete: Promise<void> = Promise.resolve();
	let readies = 0;
	const rows = new Set<Writable<SessionRow>>();
	let movedValue: SessionDetail = { locations: {} };
	let failUndo = false;
	const details = new Set<Writable<SessionDetail>>();
	const holdings = new Set<Writable<Held | undefined>>();
	const given = new Map<string, readonly string[]>([["person:owner", ["read", "send", "stop", "manage"]]]);
	const answers = new Set<{ caller: string; answer: Writable<{ kind: string; ticks: string[] } | null> }>();
	const kinds = new Map<string, string>();
	const answerOf = (caller: string) => {
		const ticks = given.get(caller);
		return ticks === undefined ? null : { kind: kinds.get(caller) ?? SessionKind.name, ticks: [...ticks] };
	};
	const control: Server = {
		reports: [],
		requests: [],
		given: new Map(),
		row: (change) => {
			rowValue = { ...rowValue, ...change };
			for (const writable of rows) writable.set(rowValue);
		},
		moved: () => movedValue.locations,
		failNextUndo: () => {
			failUndo = true;
		},
		hold: (next) => {
			grouped = group([...next, DEVICE], grouped);
			heldValue = grouped;
			for (const writable of holdings) writable.set(heldValue);
		},
		ticks: (caller, ticks, kind) => {
			if (ticks === null) given.delete(caller);
			else given.set(caller, ticks);
			if (kind === undefined) kinds.delete(caller);
			else kinds.set(caller, kind);
			for (const each of answers) if (each.caller === caller) each.answer.set(answerOf(caller));
		},
		slow: (next) => {
			release = next;
		},
		loading: (next) => {
			complete = next;
		},
		get readies() {
			return readies;
		},
	};
	const count = (kind: string) => control.given.set(kind, (control.given.get(kind) ?? 0) + 1);
	const server = defineFacet((host) => {
		host.serve(SessionFacts, (_params, _principal, self) => {
			const session = self.writable(rowValue);
			rows.add(session);
			const detail = self.writable(movedValue);
			details.add(detail);
			return {
				session: self.derive([session], ([value]) => value),
				detail: self.derive([detail], ([value]) => value),
				moveLocation: async ({ conversation, location }) => {
					if (location === null && failUndo) {
						failUndo = false;
						throw new Error("stand-in: the server is away for this undo");
					}
					const { [conversation]: _undone, ...others } = movedValue.locations;
					movedValue = { locations: location === null ? others : { ...others, [conversation]: location } };
					for (const writable of details) writable.set(movedValue);
					return null;
				},
				report: async ({ state }) => {
					await release;
					control.reports.push(state);
					control.row({ state });
					return null;
				},
			};
		});
		host.serve(MyAnswer, ({ caller }, _principal, self) => {
			const answer = self.writable(answerOf(caller));
			answers.add({ caller, answer });
			return { answer: self.derive([answer], ([value]) => value) };
		});
	});
	// This device's machine, as the machine kind's part gives it: its environment in the location's folder.
	const device = defineFacet((_host, self) => {
		self.contribute(
			ThingHarnessParts,
			thingHarnessPart(DeviceKind, () => ({
				env: (location) =>
					location.machine === "this-device" ? new NodeExecutionEnv({ cwd: location.folder }) : undefined,
			})),
		);
	});
	const holding = defineFacet((host) => {
		contribute(host, "test.holding", (self) => {
			const writable = self.writable<Held | undefined>(heldValue);
			holdings.add(writable);
			self.contribute(HeldThings, writable);
		});
	});
	const logins = defineFacet((_host, self) => {
		self.contribute(
			ThingHarnessParts,
			thingHarnessPart(LoginKind, (all, session) => {
				count(LoginKind.name);
				// Each provider with its login: a session's model choice names the login.
				const providers = all.map(({ thing, ref }) => ({
					thing,
					provider: scripted(ref.provider.value, ref.script.value, control.requests),
				}));
				const ready = async () => {
					readies += 1;
					await complete;
				};
				if (!all.some(({ ref }) => ref.tool.value)) return { providers, ready };
				const tool = defineTool({
					name: "test_session",
					description: "The session's folder",
					parameters: obj({}),
					execute: async (_args, _api, context) => {
						const folder = await session.call(
							async (ctx) => (await ctx.get(SessionFacts, {})).session.value?.location?.folder ?? "",
							context,
						);
						return { output: [{ type: "text", text: `folder: ${folder}` }] };
					},
				});
				return { providers, ready, extension: { tools: [tool] } };
			}),
		);
	});
	const extra = defineFacet((_host, self) => {
		for (const { kind, prompt, env, seen } of extras) {
			const Kind = defineThing(kind, { version: 1, ticks: {} });
			self.contribute(
				ThingHarnessParts,
				thingHarnessPart(Kind, (_things, session) => {
					count(kind);
					seen?.(session);
					return {
						...(prompt === undefined ? {} : { extension: { sections: [section("test-extra", () => prompt)] } }),
						...(env === undefined ? {} : { env }),
					};
				}),
			);
		}
	});
	const stubs: PluginFacet<P3Principal>[] = [
		{ name: "@earendil-works/p3-things", facet: things },
		{ name: "@earendil-works/p3-tools", facet: tools },
		{ name: "test.device", facet: device },
		{ name: "test.holding", facet: holding },
		{ name: "test.logins", facet: logins },
		{ name: "test.extra", facet: extra },
	];
	return { server: [{ name: "test.server", facet: server }], stubs, control };
}

/** `holdings` grouped by kind; a kind whose entries are those of `before`'s list, in order, keeps that list. */
function group(holdings: readonly Holding[], before: Held): Held {
	const lists = new Map<string, HeldThing[]>();
	for (const { kind, held } of holdings) lists.set(kind, [...(lists.get(kind) ?? []), held]);
	const held = new Map<string, readonly HeldThing[]>();
	for (const [kind, list] of lists) {
		const old = before.get(kind);
		const same = old !== undefined && old.length === list.length && old.every((each, at) => each === list[at]);
		held.set(kind, same ? old : list);
	}
	return held;
}

/** A faux provider `provider` answering from `script`, recording each request into `requests`. */
function scripted(provider: string, script: readonly Step[], requests: Request[]) {
	const faux = fauxProvider({ provider, models: [{ id: `${provider}-model` }] });
	const answer = (context: { messages: Message[] }) => {
		const last = lastText(context.messages);
		const step = script.find(({ when }) => last.includes(when));
		requests.push({
			provider,
			last,
			tools: offered(context.messages),
			prompt: prompted(context.messages),
			removed: removed(context.messages),
		});
		// One answer queued at a time: each request queues the next.
		faux.appendResponses([answer]);
		if (step === undefined)
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: `unscripted: ${last}` });
		const content = step.reply.map((part) =>
			part.kind === "text" ? fauxText(part.text) : fauxToolCall(part.name, JSON.parse(part.args)),
		);
		return fauxAssistantMessage(content, {
			stopReason: step.reply.some((part) => part.kind === "tool") ? "toolUse" : "stop",
		});
	};
	faux.setResponses([answer]);
	// An empty script: a login whose models are all hidden.
	return script.length === 0 ? { ...faux.provider, getModels: () => [] } : faux.provider;
}

/** The text of the last message that is not a system message (a change of tools): the user's, or a tool result's. */
function lastText(messages: readonly Message[]): string {
	const last = messages.findLast((message) => message.role !== "system");
	if (last === undefined || last.role === "assistant") return "";
	if (typeof last.content === "string") return last.content;
	return last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The system prompt's sections the request has: its system messages' sections, later ones replacing, in order. */
function prompted(messages: readonly Message[]): string {
	const sections = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const [key, text] of Object.entries(message.sections ?? {})) {
			if (text === null) sections.delete(key);
			else sections.set(key, text);
		}
	}
	return [...sections.values()].join("\n");
}

/** The tools the request's last change of tools took away. */
function removed(messages: readonly Message[]): string[] {
	const last = messages.findLast((message) => message.role === "system" && message.toolsRemoved !== undefined);
	return last?.role === "system" ? (last.toolsRemoved ?? []).map((tool) => tool.name) : [];
}

/** The tools the request offers: its system messages' additions minus their removals, in order. */
function offered(messages: readonly Message[]): string[] {
	const tools: string[] = [];
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) tools.splice(tools.indexOf(removed.name), 1);
		for (const added of message.toolsAdded ?? []) tools.push(added.name);
	}
	return tools.toSorted();
}
