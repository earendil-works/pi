// Tests of `TuiScope` (slice 11 §4, decision "Slice 11, P9"): references held for a component, watchables and
// registries followed, one `changed` callback for every change, everything released at `dispose`, and the host's page
// state shared by every scope (decision "Tutorial gaps" (1)), and messages in the host's language, a change redrawing
// (decision "Messages and languages in the app kit"), and an optimistic value shown while a call is pending (decision
// "A call's answer follows its state").

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import {
	createHost,
	createLanguage,
	defineFacet,
	defineMessages,
	defineRegistry,
	event,
	hostLanguage,
	local,
	method,
	str,
} from "../../src/index.ts";
import { NO_TRANSLATIONS } from "../../src/surfaces/translations.ts";
import { TuiScope } from "../../src/tui/scope.ts";

const Notes = local("test.notes", {
	version: 1,
	params: {},
	members: { text: str(), write: method(str()), written: event(str()) },
});

const Panels = defineRegistry<string, readonly string[]>("test.panels", { version: 1 });

/** A host serving `Notes` (a writable text) and `Panels` with one contribution. */
async function host() {
	const created = createHost({ onError: () => {} });
	await created.load(
		[
			{
				name: "@test/notes",
				facet: defineFacet((h, self) => {
					h.serve(Notes, (_params, object) => {
						const text = object.writable("first");
						const written = object.events<string>();
						return {
							text: object.derive([text], ([value]) => value),
							written,
							write: async (next) => {
								text.set(next);
								written.emit(next);
								return null;
							},
						};
					});
					h.serve(Panels, { compose: (table) => table.map(({ value }) => value) });
					self.contribute(Panels, "notes");
				}),
			},
		],
		context,
	);
	return created;
}

/** Waits until `check` holds. */
async function until(check: () => boolean): Promise<void> {
	for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
}

describe("a component's scope", () => {
	it("holds, follows and calls changed on every change; releases everything at dispose", async () => {
		const h = await host();
		let changes = 0;
		const scope = new TuiScope(h, () => changes++);
		const notes = scope.hold(Notes, {});
		const text = scope.watch(notes.text);
		const panels = scope.registry(Panels);
		await until(() => text() === "first" && panels()?.[0] === "notes");
		const before = changes;
		await notes.write("second", context);
		await until(() => text() === "second" && changes > before);
		scope.dispose();
		expect(notes.state.value.kind).toBe("ended");
		const after = changes;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(changes).toBe(after);
		await h.close(context);
	});

	it("reads undefined from a watchable without a value, never throwing", async () => {
		const h = await host();
		const scope = new TuiScope(h, () => {});
		const read = scope.watch({
			get value(): string {
				throw new Error("not ready");
			},
			watch: () => Promise.reject(new Error("not ready")),
		});
		expect(read()).toBeUndefined();
		scope.dispose();
		await h.close(context);
	});
});

describe('a scope\'s event subscriptions (decision "Events: fire-and-forget members")', () => {
	it("call the listener for each event, never changed by themselves, until dispose", async () => {
		const created = await host();
		let changes = 0;
		const scope = new TuiScope(created, () => changes++);
		const notes = scope.hold(Notes, {});
		await until(() => notes.state.value.kind === "live");
		const seen: string[] = [];
		scope.on(notes.written, ({ value }) => void seen.push(value));
		const before = changes;
		await notes.write("a", context);
		await until(() => seen.length === 1);
		// The event called its listener only (the text is not followed here: nothing else changed).
		expect(changes).toBe(before);
		scope.dispose();
		const again = await created.get(Notes, {}, context);
		await again.write("b", context);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(seen).toEqual(["a"]);
	});
});

describe("a scope's optimistic values", () => {
	it("show the value while its call is pending, then the reader's, calling changed on each change", async () => {
		const h = await host();
		let changes = 0;
		const scope = new TuiScope(h, () => changes++);
		const notes = scope.hold(Notes, {});
		const [text, add] = scope.optimistic(scope.watch(notes.text));
		await until(() => text() === "first");
		const before = changes;
		const written = add("second", notes.write("second", context));
		expect(text()).toBe("second");
		expect(changes).toBe(before + 1);
		await written;
		await until(() => changes > before + 1);
		expect(text()).toBe("second");
		scope.dispose();
		await h.close(context);
	});

	it("show the last value until every call settled; a rejected call drops it as a resolved one does", async () => {
		const h = await host();
		const calls: string[] = [];
		const scope = new TuiScope(h, () => calls.push(text()!));
		const [text, add] = scope.optimistic(() => "real");
		const first = Promise.withResolvers<null>();
		const second = Promise.withResolvers<null>();
		add("one", first.promise);
		const failing = add("two", second.promise);
		first.resolve(null);
		await first.promise;
		await Promise.resolve();
		expect(text()).toBe("two");
		second.reject(new Error("refused"));
		await expect(failing).rejects.toThrow("refused");
		await Promise.resolve();
		expect(calls).toEqual(["one", "two", "two", "real"]);
		scope.dispose();
		await h.close(context);
	});

	it("apply a reducer over every action in flight, in order, and say whether a call is pending", async () => {
		const h = await host();
		const scope = new TuiScope(h, () => {});
		let real = ["a", "b", "c"];
		const [list, add, pending] = scope.optimistic(
			() => real,
			(current: string[], removed: string) => current.filter((each) => each !== removed),
		);
		const first = Promise.withResolvers<null>();
		const second = Promise.withResolvers<null>();
		add("a", first.promise);
		add("c", second.promise);
		expect(list()).toEqual(["b"]);
		// Unchanged reader and actions: the same value, not a new array per read.
		expect(list()).toBe(list());
		expect(pending()).toBe(true);
		// The first call settled with its change committed: both actions stay until the second settles too.
		real = ["b", "c"];
		first.resolve(null);
		await first.promise;
		await Promise.resolve();
		expect(list()).toEqual(["b"]);
		real = ["b"];
		second.resolve(null);
		await second.promise;
		await Promise.resolve();
		expect(list()).toBe(real);
		expect(pending()).toBe(false);
		scope.dispose();
		await h.close(context);
	});

	it("never call changed after dispose", async () => {
		const h = await host();
		let changes = 0;
		const scope = new TuiScope(h, () => changes++);
		const [, add] = scope.optimistic(() => "real");
		const call = Promise.withResolvers<null>();
		add("shown", call.promise);
		scope.dispose();
		call.resolve(null);
		await call.promise;
		await Promise.resolve();
		expect(changes).toBe(1);
		await h.close(context);
	});
});

describe("a scope's page state", () => {
	it("is the host's: a scope opened after another was disposed (a reload) finds its value, a new key starts fresh", async () => {
		const h = await host();
		const before = new TuiScope(h, () => {});
		before.pageState("draft", "").set("oat mi");
		before.dispose();
		const after = new TuiScope(h, () => {});
		expect(after.pageState("draft", "").read()).toBe("oat mi");
		expect(after.pageState("scroll", 0).read()).toBe(0);
		after.dispose();
		await h.close(context);
	});

	it("calls changed on each open scope following the key, and never after dispose", async () => {
		const h = await host();
		const calls: string[] = [];
		const redraw = (name: string) => () => calls.push(name);
		const first = new TuiScope(h, redraw("first"));
		const second = new TuiScope(h, redraw("second"));
		const draft = first.pageState("draft", "");
		second.pageState("draft", "");
		draft.set("a");
		first.dispose();
		draft.set("b");
		expect(calls).toEqual(["first", "second", "second"]);
		second.dispose();
		await h.close(context);
	});
});

describe("a scope's messages", () => {
	it("render in the host's language at each call, a change of it calling changed until dispose", async () => {
		const h = await host();
		const notes = defineMessages("notes", {
			en: { title: "Notes", count: (n: number) => `${n} notes` },
			de: { title: "Notizen", count: (n) => `${n} Notizen` },
		});
		let changes = 0;
		const scope = new TuiScope(h, () => changes++);
		const t = scope.messages(notes);
		expect(t("title")).toBe("Notes");
		hostLanguage(h).set(createLanguage("de", NO_TRANSLATIONS, () => {}));
		expect(changes).toBe(1);
		expect([t("title"), t("count", 2), t.render(notes.message("count", 3))]).toEqual([
			"Notizen",
			"2 Notizen",
			"3 Notizen",
		]);
		scope.dispose();
		hostLanguage(h).set(createLanguage("en", NO_TRANSLATIONS, () => {}));
		expect(changes).toBe(1);
		await h.close(context);
	});
});
