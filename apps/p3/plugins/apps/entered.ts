// The apps a person is in through sessions, for the catalog: one `AppEntered` per app in `Apps`. A factory cannot
// declare a read per registry entry (the entries are known only once it is live, and they change), so a routine of the
// catalog follows `Apps`, holds the `AppEntered` of each app it lists, releases the one of an app that left, and keeps
// the apps whose answer is true in a writable the catalog's derive reads.

import {
	type AppInfo,
	bool,
	type Ctx,
	local,
	type P3Principal,
	type Reference,
	type RegistryValue,
	type Self,
	str,
	type TableItem,
	untilAborted,
	type Writable,
} from "@earendil-works/p3/v1";

/**
 * Whether person `person` is a member of an active session of app `app`, directly or through one of their groups (the
 * apps plugin's server facet serves it).
 */
export const AppEntered = local("apps.entered", {
	version: 1,
	params: { app: str(), person: str() },
	members: { entered: bool() },
});

/** One app's held answer and its watch. */
type Followed = {
	readonly ref: Reference<typeof AppEntered>;
	readonly stop: () => Promise<unknown>;
	entered: boolean;
};

/**
 * The ids of the apps of `apps` whose `AppEntered` (made by `get` in the routine's ctx) answers true, live: empty
 * until the routine has read them.
 */
export function followEntered(
	self: Self<P3Principal>,
	apps: RegistryValue<ReadonlyMap<string, TableItem<AppInfo>>>,
	get: (app: string, ctx: Ctx<P3Principal>) => Promise<Reference<typeof AppEntered>>,
): Writable<ReadonlySet<string>> {
	const entered = self.writable<ReadonlySet<string>>(new Set());
	self.onLive(async (ctx) => {
		const followed = new Map<string, Followed>();
		const publish = () =>
			entered.set(new Set([...followed].filter(([, { entered }]) => entered).map(([app]) => app)));
		/** Holds the answers of the apps `table` lists and not yet held, and releases those of apps it lists no more. */
		const sync = async (table: ReadonlyMap<string, TableItem<AppInfo>>) => {
			for (const [app, held] of followed) {
				if (table.has(app)) continue;
				followed.delete(app);
				await held.stop();
				held.ref.release();
			}
			for (const app of table.keys()) {
				if (followed.has(app)) continue;
				const ref = await get(app, ctx);
				const watch = await ref.entered.watch(ctx);
				const held: Followed = { ref, stop: () => watch.stop(), entered: watch.value };
				followed.set(app, held);
				watch.start(async (call) => {
					if (call.kind !== "value") return;
					held.entered = call.value;
					publish();
				});
			}
			publish();
		};
		const watch = await apps.watch(ctx);
		try {
			await sync(watch.value);
			// One change at a time: a watch's calls are delivered in order, each awaited.
			watch.start(async (call) => {
				if (call.kind === "value") await sync(call.value);
			});
			await untilAborted(ctx);
		} finally {
			await watch.stop();
			for (const held of followed.values()) await held.stop();
		}
	});
	return entered;
}
