// The counter's server side: one store keeps every session's count (persisted) and emits waves; each person's (and
// the session's agent's) Counter object shows the session's count and who is there, and adds and waves for those who
// may send.
import { int, obj, str } from "@earendil-works/pi-schema";
import {
	canSend,
	canView,
	defineFacet,
	defineState,
	event,
	forbidden,
	isWorker,
	keyed,
	local,
	method,
	untilAborted,
} from "@p2/app/v1";
import { Counter } from "./contract.ts";

const Counts = defineState("counter.counts", {
	schema: obj({ value: int() }),
	version: 1,
	initial: () => ({ value: 0 }),
	keyed: true,
	persist: true,
	checkpointWhen: () => true,
});

const Store = local("counter.store", {
	version: 1,
	params: {},
	members: {
		counts: keyed(obj({ value: int() })),
		waved: event(obj({ session: str(), from: str() })),
		add: method(obj({ session: str(), by: int() })),
		wave: method(obj({ session: str(), from: str() })),
	},
});

export default defineFacet((host) => {
	host.serve(Store, (_params, self) => {
		const counts = self.state(Counts);
		const waved = self.events<{ session: string; from: string }>();
		return {
			counts,
			waved,
			add: async ({ session, by }, ctx) => {
				await counts.change(
					session,
					(draft) => {
						draft.value += by;
					},
					ctx,
				);
				return null;
			},
			wave: async ({ session, from }) => {
				waved.emit({ session, from });
				return null;
			},
		};
	});

	const references = host.references(Counter);
	host.serve(Counter, ({ session }, principal, self) => {
		// The session's own agent (its worker) may use it too: the plugin's tool.
		const agent = isWorker(principal) && principal.session === session;
		if (!agent && !canView(principal, session)) throw forbidden("the session's viewers only");
		const store = self.get(Store, {});
		const name = principal.kind === "guest" ? principal.name : principal.kind === "worker" ? "agent" : principal.kind;
		const count = self.derive([store.counts.at(session)], ([doc]) => doc.value);
		const present = self.derive([references], ([list]) => [
			...new Set(
				list
					.filter((each) => each.params.session === session)
					.map((each) => (each.principal?.kind === "guest" ? each.principal.name : (each.principal?.kind ?? "?"))),
			),
		]);
		// Waves of this session only, re-emitted from this object's own source.
		const waved = self.events<{ from: string }>();
		self.onLive(async (ctx) => {
			const subscription = await store.waved.on(({ value }) => {
				if (value.session === session) waved.emit({ from: value.from });
			}, ctx);
			try {
				await untilAborted(ctx);
			} finally {
				subscription.stop();
			}
		});
		const mayAdd = () => {
			if (!agent && !canSend(principal, session)) throw forbidden("only people who may send here");
		};
		return {
			variant: "player",
			members: {
				count,
				present,
				waved,
				add: async ({ by }, ctx) => {
					mayAdd();
					await store.add({ session, by }, ctx);
					return null;
				},
				wave: async (ctx) => {
					mayAdd();
					await store.wave({ session, from: name }, ctx);
					return null;
				},
			},
		};
	});
});
