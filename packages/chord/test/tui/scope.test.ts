// Tests of `TuiScope` (slice 11 §4, decision "Slice 11, P9"): references held for a component, watchables and
// registries followed, one `changed` callback for every change, and everything released at `dispose`.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { createHost, defineFacet, defineRegistry, local, method, str } from "../../src/index.ts";
import { TuiScope } from "../../src/tui/scope.ts";

const Notes = local("test.notes", { version: 1, params: {}, members: { text: str(), write: method(str()) } });

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
						return {
							text: object.derive([text], ([value]) => value),
							write: async (next) => {
								text.set(next);
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
