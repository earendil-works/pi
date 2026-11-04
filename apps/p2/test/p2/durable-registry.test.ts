// The Extensions registry as Durable's RegistryReader: one complete snapshot per table, swapped at reload.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { bool } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, local, method, whenLive } from "@p2/app/v1";
import { defineFacet, type Facet, Session } from "../../src/runtime/chord.ts";
import { durableRegistry, ExtensionSwitches } from "../../src/runtime/durable.ts";
import { Extensions } from "../../src/runtime/worker.ts";
import { testHost } from "./helpers.ts";

/** A facet contributing one extension named `name` whose section renders `text`. */
const facet = (name: string, text: string): Facet =>
	defineFacet((_host, self) =>
		self.contribute(Extensions, { [name]: defineExtension({ name, sections: [section(name, () => text)] }) }),
	);

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The bridge over a test host's Extensions and ExtensionSwitches. */
async function readerOf(fixture: Awaited<ReturnType<typeof testHost>>) {
	const [extensions, switches] = await Promise.all([
		fixture.host.registry(Extensions, BACKGROUND_CONTEXT),
		fixture.host.registry(ExtensionSwitches, BACKGROUND_CONTEXT),
	]);
	return durableRegistry(extensions, switches, BACKGROUND_CONTEXT);
}

describe("durable registry bridge", () => {
	it("publishes one snapshot per table, in plugin order, and swaps it at reload", async (t) => {
		const guard = facet("guard", "v1");
		const tools = facet("tools", "tools");
		const fixture = await testHost({ address: Session({ id: "w" }), kind: "worker", facets: [guard, tools] });
		t.after(() => fixture.close());
		const reader = await readerOf(fixture);
		let published = 0;
		reader.subscribe(() => published++);
		const first = reader.snapshot();
		assert.deepEqual(
			first.installed().map((extension) => extension.name),
			["guard", "tools"],
		);
		// Unchanged table: the same immutable snapshot (a Durable phase pins it).
		assert.equal(reader.snapshot(), first);
		await fixture.reload([facet("guard", "v2"), tools]);
		await tick();
		const second = reader.snapshot();
		assert.notEqual(second, first);
		assert.deepEqual(
			second.installed().map((extension) => extension.name),
			["guard", "tools"],
		);
		const render = second.extension("guard")?.sections?.[0]?.render as () => string;
		assert.equal(render(), "v2");
		// The old snapshot still has the old code.
		assert.equal((first.extension("guard")?.sections?.[0]?.render as () => string)(), "v1");
		assert.ok(published > 0);
	});

	it("leaves an extension out while its switch reads false, without unregistering it", async (t) => {
		const Switch = local("t.switch", {
			version: 1,
			params: {},
			members: { on: bool(), set: method(bool()) },
		});
		const switched = defineFacet((host) =>
			host.serve(Switch, (_params, self) => {
				const on = self.writable(true);
				self.contribute(Extensions, { switched: defineExtension({ name: "switched" }) });
				self.contribute(
					ExtensionSwitches,
					self.derive([on], ([value]) => ({ switched: value })),
				);
				return {
					on: self.derive([on], ([value]) => value),
					set: async (next) => {
						on.set(next);
						return null;
					},
				};
			}),
		);
		const fixture = await testHost({
			address: Session({ id: "w" }),
			kind: "worker",
			facets: [switched, facet("guard", "v1")],
		});
		t.after(() => fixture.close());
		const reader = await readerOf(fixture);
		let published = 0;
		reader.subscribe(() => published++);
		const control = fixture.host.hold(Switch, {}, BACKGROUND_CONTEXT);
		await whenLive(control);
		await tick();
		const names = () =>
			reader
				.snapshot()
				.installed()
				.map((extension) => extension.name);
		assert.deepEqual(names(), ["switched", "guard"]);
		const on = reader.snapshot();
		await control.set(false, BACKGROUND_CONTEXT);
		await tick();
		assert.deepEqual(names(), ["guard"]);
		assert.ok(published > 0, "Durable hears that the registry changed");
		// The phase that pinned the earlier snapshot keeps it.
		assert.deepEqual(
			on.installed().map((extension) => extension.name),
			["switched", "guard"],
		);
		const before = published;
		await control.set(true, BACKGROUND_CONTEXT);
		await tick();
		assert.deepEqual(names(), ["switched", "guard"]);
		assert.ok(published > before);
	});
});
