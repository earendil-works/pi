// Running a rollup's script (server): the sessions as the script sees them, the script wrapped so it records what it
// reads (session fields, projects, the time, its `mentions` calls), the fingerprint of those values (unchanged: the run
// is skipped), and the script's output checked against `RollupOutputSchema`, the trust boundary between the script and
// the sidebar.
import { createHash } from "node:crypto";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { arr, compile, num, obj, opt, type Static, str, unknown } from "@earendil-works/pi-schema";
import type { Project } from "../projects/contract.ts";
import type { Session } from "../sessions/contract.ts";
import type { Status } from "../status/contract.ts";
import { type Preview, RollupOutputSchema, type RollupSession } from "./contract.ts";

/**
 * What a script reads: every session but the Familiar's (oldest first, so activity does not reorder them), the
 * projects, the time.
 */
export type RollupInput = {
	readonly sessions: readonly RollupSession[];
	readonly projects: readonly Project[];
	readonly now: number;
};

/** The facts a rollup's input is made of, as the server's objects hold them. */
export type RollupFacts = {
	readonly sessions: readonly Session[];
	readonly statuses: Readonly<Record<string, Status>>;
	/** The newest root answer and the owner's read mark, by session (`SearchIndex`). */
	readonly answers: Readonly<Record<string, number>>;
	readonly reads: Readonly<Record<string, number>>;
	readonly projects: readonly Project[];
	readonly memberships: Readonly<Record<string, string>>;
	/** The Familiar's session: the sidebar lists it above the rollups, never in one. */
	readonly familiar: string | null;
};

/** The input of a run at `now`. */
export function inputOf(facts: RollupFacts, now: number): RollupInput {
	const sessions = facts.sessions
		.filter((session) => session.id !== facts.familiar)
		.map((session): RollupSession => {
			const status = facts.statuses[session.id];
			return {
				id: session.id,
				title: session.title,
				env: session.env ?? null,
				cwd: session.cwd,
				createdAt: session.createdAt,
				updatedAt: session.updatedAt,
				archivedAt: session.archivedAt,
				pinned: session.pinned,
				model: `${session.model.provider}/${session.model.modelId}`,
				project: facts.memberships[session.id] ?? null,
				state: !status?.running ? "stopped" : status.busy.length > 0 ? "working" : "idle",
				error: status?.error ?? null,
				unread: (facts.answers[session.id] ?? 0) > (facts.reads[session.id] ?? 0),
			};
		})
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	return { sessions, projects: facts.projects, now };
}

/**
 * The fingerprint of what a run read of `input`: the sessions' IDs in order always, the fields it read of each (every
 * field after `sessions.*`), the projects and the time when it read them, and what each `mentions` call it made
 * answered (`mentions`, by its read path). Equal fingerprints mean the script would compute the same output again: it
 * is a function of what it read.
 */
export function fingerprintOf(
	input: RollupInput,
	reads: readonly string[],
	mentions: ReadonlyMap<string, unknown>,
): string {
	const all = reads.includes("sessions.*");
	const fields = reads.flatMap((path) =>
		path.startsWith("sessions.") && path !== "sessions.*" ? [path.slice(9)] : [],
	);
	const sessions = input.sessions.map((session) => {
		if (all) return session;
		const record: Readonly<Record<string, unknown>> = session;
		return [session.id, ...fields.map((field) => record[field] ?? null)];
	});
	const facts = [
		sessions,
		reads.includes("projects") ? input.projects : null,
		reads.includes("now") ? input.now : null,
		reads.flatMap((path) => (path.startsWith(MENTIONS_READ) ? [[path, mentions.get(path) ?? null]] : [])),
	];
	return createHash("sha256").update(JSON.stringify(facts)).digest("base64url");
}

/** How long a script may run, and how much memory its VM may take. */
export const RUN_TIMEOUT_MS = 5_000;
export const RUN_MEMORY_BYTES = 64 * 1024 * 1024;

const MENTION_FIELDS = { query: str({ minLength: 1, maxLength: 500 }), since: opt(num()) };

/** A `mentions(query, { since })` call of a script: what it asked the search index. */
export const MentionSchema = obj(MENTION_FIELDS);
export type Mention = Static<typeof MentionSchema>;

/** The sandbox global behind `mentions`, called with the run's token and the call (`isMentionCall`). */
export const MENTIONS_GLOBAL = "__p2Mentions";

/** Whether a call of `MENTIONS_GLOBAL` (script input) is a run's token with a `mentions` call. */
export const isMentionCall = compile(obj({ run: str(), ...MENTION_FIELDS })).check;

/** The read path of a `mentions` call, as the wrapper records it (the same keys in the same order). */
export const mentionRead = ({ query, since }: Mention): string =>
	MENTIONS_READ + JSON.stringify(since === undefined ? { query } : { query, since });

/** The `mentions` call a read path records, or undefined for another read. */
export function mentionOf(path: string): Mention | undefined {
	if (!path.startsWith(MENTIONS_READ)) return undefined;
	try {
		const mention: unknown = JSON.parse(path.slice(MENTIONS_READ.length));
		return MENTION.check(mention) ? mention : undefined;
	} catch {
		// A read path the script itself broke: no call to repeat.
		return undefined;
	}
}

const MENTIONS_READ = "mentions:";
const MENTION = compile(MentionSchema);

/**
 * Runs `code` against `input` as run `run` (the token its `mentions` calls carry): its output and what it read, or why
 * it failed.
 */
export async function runRollup(
	sandbox: CodemodeSandbox,
	code: string,
	input: RollupInput,
	run: string,
): Promise<Preview> {
	const result = await sandbox.execute(wrap(code), {
		store: { [INPUT_KEY]: input, [RUN_KEY]: run },
		timeoutMs: RUN_TIMEOUT_MS,
	});
	if (!result.ok) return { ok: false, error: `${result.error.name ?? result.error.kind}: ${result.error.message}` };
	// The wrapper returns `{ output, reads }`; the script's own code ran inside it and may have broken it.
	if (!WRAPPED.check(result.value) || result.value.output === undefined)
		return { ok: false, error: "The script returned nothing: return the rollup." };
	const { output, reads } = result.value;
	if (!OUTPUT.check(output)) {
		const errors = OUTPUT.errors(output).slice(0, 3);
		const text = errors.map((each) => `${each.path || "(root)"} ${each.message}`).join("; ");
		return { ok: false, error: `The returned rollup does not match its schema: ${text}` };
	}
	return { ok: true, output, reads };
}

const WRAPPED = compile(obj({ output: unknown(), reads: arr(str()) }));
const OUTPUT = compile(RollupOutputSchema);

const INPUT_KEY = "p2.rollup-input";
const RUN_KEY = "p2.rollup-run";

/**
 * `code` inside a function that gives it `sessions` (each a proxy recording the fields read), `projects` (recording
 * any read), `now()` (recording that the time was read) and `mentions(query, { since })` (recording the call), and
 * returns its output with the paths it read.
 */
function wrap(code: string): string {
	return `const __reads = new Set();
const __input = load(${JSON.stringify(INPUT_KEY)});
const __field = (key) => { if (typeof key === "string") __reads.add("sessions." + key); };
const sessions = __input.sessions.map((row) => new Proxy(row, {
	get(target, key, receiver) { __field(key); return Reflect.get(target, key, receiver); },
	has(target, key) { __field(key); return Reflect.has(target, key); },
	getOwnPropertyDescriptor(target, key) { __field(key); return Reflect.getOwnPropertyDescriptor(target, key); },
	ownKeys(target) { __reads.add("sessions.*"); return Reflect.ownKeys(target); },
}));
const projects = new Proxy(__input.projects, {
	get(target, key, receiver) { __reads.add("projects"); return Reflect.get(target, key, receiver); },
	ownKeys(target) { __reads.add("projects"); return Reflect.ownKeys(target); },
});
const now = () => { __reads.add("now"); return __input.now; };
const __run = load(${JSON.stringify(RUN_KEY)});
const mentions = async (query, options = {}) => {
	const call = options.since === undefined ? { query } : { query, since: options.since };
	__reads.add(${JSON.stringify(MENTIONS_READ)} + JSON.stringify(call));
	return ${MENTIONS_GLOBAL}({ run: __run, ...call });
};
const __output = await (async () => {
${code}
})();
return { output: __output, reads: [...__reads] };`;
}
