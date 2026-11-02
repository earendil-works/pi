// The session example 60 syncs: one object per host with a persisted title document and a `messages` table, and a
// helper running a host on a store for the length of some work (one open host per store; a closed host holds no
// claims, so a batch may apply to its store afterwards).
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../../src/contracts/index.ts";
import { defineState } from "../../../src/documents/index.ts";
import { createHost, defineFacet, type Reference } from "../../../src/host/index.ts";
import { defineTable, query, type Store } from "../../../src/store/index.ts";

const Messages = defineTable("messages", {
	version: 1,
	columns: { n: int(), role: str(), text: str() },
	key: ["n"],
});

const Title = defineState("title", {
	schema: obj({ text: str() }),
	version: 1,
	initial: () => ({ text: "untitled" }),
	persist: true,
	checkpointWhen: () => false,
});

/** The session's contract: its title, a message (one commit each), a rename (one commit) and the transcript. */
export const Session = local("example.session", {
	version: 1,
	params: {},
	members: {
		title: obj({ text: str() }),
		say: method(obj({ role: str(), text: str() }), int()),
		rename: method(str()),
		transcript: method(obj({}), arr(str())),
	},
});

const facet = defineFacet((host) => {
	host.serve(Session, (_, self) => {
		const messages = self.table(Messages);
		const title = self.state(Title);
		const all = query(Messages).orderBy((m) => m.n, "asc");
		return {
			title,
			say: async ({ role, text }, ctx) => {
				const n = (await messages.count(all, ctx)) + 1;
				await self.tx(async (tx) => tx.put(messages, { n, role, text }), ctx);
				return n;
			},
			rename: async (text, ctx) => {
				await title.change((draft) => {
					draft.text = text;
				}, ctx);
				return null;
			},
			transcript: async (_, ctx) => {
				const lines: string[] = [];
				for await (const m of messages.rows(all, ctx)) lines.push(`${m.n} ${m.role}: ${m.text}`);
				return lines;
			},
		};
	});
});

/** Runs a host serving the session on `store` until `work` is done, then closes the host (the store stays open). */
export async function withSession<T>(
	store: Store,
	work: (session: Reference<typeof Session>) => Promise<T>,
): Promise<T> {
	const host = createHost({ store, onError: (error) => console.error("background error:", error) });
	try {
		await host.load([{ name: "@example/session", facet }], context);
		return await work(await host.get(Session, {}, context));
	} finally {
		await host.close(context);
	}
}

/** The session as one line: its title and its messages. */
export function describe(store: Store): Promise<string> {
	return withSession(store, async (session) => {
		const lines = await session.transcript({}, context);
		return `"${session.title.value.text}" [${lines.join(" | ")}]`;
	});
}
