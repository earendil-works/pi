// A denial with a message (slice 15 §2): `deny(reason, message)`. The reason is English, for logs; the message is
// data (`{ namespace, key, params }`) the person's client renders in their language. It reaches the denied holder in
// its failure's `details.message`, goes with a call the denial refused, and is part of the decision: another message
// is a new failure, nothing rebuilt.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/78-denial-messages.ts
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { grantable, hostKind, map, method, obj, remote, str } from "../../src/contracts/index.ts";
import type { ChordError, MessageData } from "../../src/data/index.ts";
import { allow, createHost, defineFacet, deny, local } from "../../src/index.ts";
import { memoryLinkPair } from "../../src/link/index.ts";
import { constant } from "../../src/state/index.ts";
import { defineMessages } from "../../src/surfaces/index.ts";

const context = BACKGROUND_CONTEXT;

type Principal = { kind: "person"; id: string } | { kind: "server" };

const Server = hostKind("server");

// 1. The messages, once, for every client that renders them: English and German.
const messages = defineMessages("example.canvas", {
	en: {
		notShared: (owner: string) => `This canvas is ${owner}'s. Ask them to share it.`,
		removed: "You were removed from this canvas.",
	},
	de: {
		notShared: (owner: string) => `Diese Leinwand gehört ${owner}. Bitte um eine Freigabe.`,
		removed: "Du wurdest von dieser Leinwand entfernt.",
	},
});

const Canvas = remote("example.messages-canvas", {
	version: 1,
	params: { canvas: str() },
	hostAddress: () => Server(),
	state: { title: str() },
	methods: { add: grantable(method(str())) },
});

// Who may draw: a person's status on the canvas (`draw`, `removed`, or nothing).
const Shares = local("example.messages-shares", {
	version: 1,
	params: {},
	members: { status: map(str()), set: method(obj({ person: str(), status: str() })) },
});

const facet = defineFacet<Principal>((host) => {
	host.serve(Shares, (_params, self) => {
		const status = self.writable<Record<string, string>>({});
		return {
			status: self.derive([status], ([value]) => value),
			set: async ({ person, status: next }) => {
				status.set({ ...status.value, [person]: next });
				return null;
			},
		};
	});
	host.serve(Canvas, ({ canvas }) => ({ title: constant(`canvas ${canvas}`), add: async () => null }), {
		// 2. The admission denies with a reason for the logs and a message for the person.
		admit: (_params, principal, self) =>
			self.derive([self.get(Shares, {}).status], ([status]) => {
				if (principal.kind === "server") return allow({ granted: ["add"] });
				const mine = status[principal.id];
				if (mine === "draw") return allow({ granted: ["add"] });
				if (mine === "removed") return deny("removed from the canvas", messages.message("removed"));
				return deny("not shared with this person", messages.message("notShared", "Mario"));
			}),
	});
});

const server = createHost<Principal>({ address: Server(), principal: { kind: "server" }, onError: console.error });
await server.load([{ name: "@example/canvas", facet }], context);
const page = createHost<Principal>({ onError: console.error });
await page.load([], context);
const [a, b] = memoryLinkPair();
server.accept(a, { principal: { kind: "person", id: "kim" } }, context);
page.connect(b, { principal: { kind: "server" } }, context);
const settled = () => new Promise((resolve) => setTimeout(resolve, 10));

/** What Kim's page shows for a denied canvas: the message, rendered. */
function shown(ref: { readonly state: { readonly value: unknown } }): string {
	const state = ref.state.value as { kind: string; cause?: { kind: string; error: ChordError } };
	if (state.kind !== "failed" || state.cause?.kind !== "denied") return state.kind;
	const { error } = state.cause;
	const message = (error.details as { message?: MessageData } | undefined)?.message;
	const rendered = message === undefined ? "(no message)" : messages.in(undefined).render(message);
	return `denied: "${rendered}" (log: ${error.message})`;
}

// 3. Kim opens a canvas nobody shared with her: the page renders the message (here in the first catalog's language;
//    a page renders it in the person's, `useMessages`).
const canvas = page.hold(Canvas, { canvas: "sketch" }, context);
await settled();
console.log("3.", shown(canvas));

// 4. Shared with her: live. Removed again: another message, a new failure; nothing is rebuilt for it.
const shares = await server.get(Shares, {}, context);
await shares.set({ person: "kim", status: "draw" }, context);
await settled();
console.log("4. shared:", shown(canvas), "| may add:", canvas.add !== undefined);
await shares.set({ person: "kim", status: "removed" }, context);
await settled();
console.log("   removed:", shown(canvas));

await page.close(context);
await server.close(context);
