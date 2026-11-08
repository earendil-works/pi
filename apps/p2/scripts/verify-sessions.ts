// Checks a running p2 against a data report (scripts/data-report.ts) through its contracts, as the owner on loopback:
// the session list (ids, titles) and, for the 10 most recently active sessions and every session with subagents or
// shares, the newest entry of each conversation as `Chat` shows it. One session at a time; a worker this script
// started is stopped again (`WorkerControl.restart`), so a phone stays under Android's limit of child processes.
//
//   node --import ./src/source.ts scripts/verify-sessions.ts [url] [--report <report.json>] [--data <dir>]
//
// `url` defaults to http://127.0.0.1:$PORT (8788); it must be loopback: the script signs in as the local owner with the
// owner key of the server's data directory (`--data`, P2_DATA_DIR or ~/.pi/p2). Without `--report` that directory is
// also reported now. Exits 1 on a difference.
import { readFileSync } from "node:fs";
import { type Contract, type Held, type WebSocketLike, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { Chat } from "../plugins/chat/contract.ts";
import { Sessions } from "../plugins/sessions/contract.ts";
import { SessionStatus, WorkerControl } from "../plugins/status/contract.ts";
import { createHost, type Host } from "../src/runtime/chord.ts";
import { dataDirectory, localOwnerSignIn } from "../src/runtime/local-owner.ts";
import { SERVER } from "../src/runtime/principals.ts";
import { follow, type HeldIn, whenLive } from "../src/runtime/refs.ts";
import { type DataReport, dataReport, type SessionReport } from "./data-report.ts";

/** How many of the most recently active sessions are checked besides those with subagents or shares. */
const NEWEST = 10;

/** The differences between the running server at `url` (its data directory: `dataDir`) and `report`, as lines. */
export async function verifySessions(url: string, report: DataReport, dataDir: string): Promise<string[]> {
	const origin = new URL(url);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
		throw new Error("Use a loopback URL (the owner)");
	const signIn = await localOwnerSignIn(origin, dataDir);
	if (signIn.kind === "unavailable") throw new Error(signIn.message);
	const socket = new WebSocket(new URL("/chord", origin.href.replace(/^http/, "ws")), {
		headers: { Origin: origin.origin, Cookie: signIn.cookie },
	});
	const host = createHost({ onError: () => {} });
	// ws's WebSocket has the subset of the API the link uses.
	host.connect(webSocketLink(socket as unknown as WebSocketLike), { principal: SERVER }, BACKGROUND_CONTEXT);
	void host.load([], BACKGROUND_CONTEXT);
	try {
		const sessions = await liveRef(host.hold(Sessions, {}, BACKGROUND_CONTEXT), "owner");
		const listed = new Map(sessions.sessions.value.map((session) => [session.id, session]));
		const problems: string[] = [];
		for (const [id, session] of Object.entries(report.sessions)) {
			const live = listed.get(id);
			if (!live && !session.archived) problems.push(`${id}: missing from the session list`);
			else if (live && live.title !== session.title)
				problems.push(`${id}: title ${JSON.stringify(session.title)} -> ${JSON.stringify(live.title)}`);
		}
		const statuses = await liveRef(host.hold(SessionStatus, {}, BACKGROUND_CONTEXT), "reader");
		for (const id of chosen(report)) {
			const wasRunning = statuses.statuses.value[id]?.running === true;
			problems.push(...(await verifySession(host, id, report.sessions[id]!)));
			if (!wasRunning) {
				const control = host.hold(WorkerControl, { session: id }, BACKGROUND_CONTEXT);
				await whenLive(control);
				await control.restart(BACKGROUND_CONTEXT);
				control.release();
			}
		}
		return problems;
	} finally {
		await host.close(BACKGROUND_CONTEXT);
	}
}

/** A held reference once it is live in `variant`. */
async function liveRef<C extends Contract, const V extends string>(ref: Held<C>, variant: V): Promise<HeldIn<C, V>> {
	await whenLive(ref);
	// The variant is checked here: TypeScript cannot narrow a held reference of a generic contract.
	if (ref.variant !== variant) throw new Error(`expected the ${variant} variant`);
	return ref as unknown as HeldIn<C, V>;
}

/** The sessions to open: active ones with subagents or shares, and the most recently active others. */
function chosen(report: DataReport): string[] {
	const active = Object.entries(report.sessions)
		.filter(([, session]) => !session.archived)
		.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
	const special = active.filter(([, session]) => session.subagents.length > 0 || session.shares.links.length > 0);
	return [...new Set([...active.slice(0, NEWEST), ...special].map(([id]) => id))];
}

/** Each conversation of the session: its newest entry as `Chat` shows it, against the report's. */
async function verifySession(host: Host, id: string, session: SessionReport): Promise<string[]> {
	const problems: string[] = [];
	for (const [conversation, expected] of Object.entries(session.conversations)) {
		const chat = host.hold(Chat, { session: id, conversation: Number(conversation) }, BACKGROUND_CONTEXT);
		try {
			await whenLive(chat);
			const view = (await settledView(chat.view)) as ConversationView | null;
			const newest = view?.entries.at(-1)?.id;
			if (newest !== expected.newest)
				problems.push(`${id}/${conversation}: newest entry ${expected.newest} -> ${String(newest)}`);
		} catch (error) {
			problems.push(`${id}/${conversation}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			chat.release();
		}
	}
	return problems;
}

/** The first defined value of a state member (its hydration). */
function settledView<T>(member: Parameters<typeof follow<T | undefined>>[0]) {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the view did not arrive within 60 s")), 60_000);
		let done = false;
		const stop = follow(member, (value) => {
			if (value === undefined || done) return;
			done = true;
			clearTimeout(timer);
			queueMicrotask(() => stop());
			resolve(value);
		});
	});
}

async function main(args: readonly string[]): Promise<void> {
	const option = (name: string) => {
		const index = args.indexOf(name);
		return index === -1 ? undefined : args[index + 1];
	};
	const url = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
	const path = option("--report");
	const dataDir = option("--data") ?? dataDirectory();
	const report = path ? (JSON.parse(readFileSync(path, "utf8")) as DataReport) : dataReport(dataDir);
	const problems = await verifySessions(url ?? `http://127.0.0.1:${process.env.PORT ?? 8788}`, report, dataDir);
	for (const line of problems) console.log(line);
	console.log(problems.length ? `${problems.length} differences` : "no differences");
	if (problems.length) process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
