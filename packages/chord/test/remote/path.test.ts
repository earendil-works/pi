import { describe, expect, it } from "vitest";
import { ChordError } from "../../src/data/index.ts";
import type { HostLink } from "../../src/remote/host-link.ts";
import { Path, type Upstream } from "../../src/remote/path.ts";

/** A holder recording where it was held and what it was told, as `name@link` and `name dropped`. */
function holder(name: string, log: string[]): Upstream {
	// The path calls only `attach` and `dropped`.
	return {
		attach: (link: { readonly name: string }) => void log.push(`${name}@${link.name}`),
		dropped: () => void log.push(`${name} dropped`),
	} as unknown as Upstream;
}

/** A link known by its name; the path only passes it on. */
function linkOf(name: string): HostLink {
	return { name } as unknown as HostLink;
}

describe("a path", () => {
	it("asks for a link when it gets a holder without one; holds every holder on each link it gets", () => {
		const log: string[] = [];
		let changes = 0;
		const path = new Path(() => changes++);
		path.attach(holder("a", log));
		path.attach(holder("b", log));
		expect(changes).toBe(2);
		expect(log).toEqual([]);
		const first = linkOf("1");
		path.connected(first);
		expect(log).toEqual(["a@1", "b@1"]);
		path.attach(holder("c", log));
		expect(log.at(-1)).toBe("c@1");
		expect(changes).toBe(2);
	});

	it("tells every holder when its link drops, then asks for the next; a stale link's drop is ignored", () => {
		const log: string[] = [];
		let changes = 0;
		const path = new Path(() => changes++);
		const [first, second] = [linkOf("1"), linkOf("2")];
		path.connected(first);
		path.attach(holder("a", log));
		path.disconnected(first);
		expect(log).toEqual(["a@1", "a dropped"]);
		expect(changes).toBe(1);
		expect(path.link).toBeUndefined();
		path.connected(second);
		path.disconnected(first);
		expect(log).toEqual(["a@1", "a dropped", "a@2"]);
		expect(changes).toBe(1);
		expect(path.link).toBe(second);
	});

	it("reports its last holder's detach: no later link holds it", () => {
		const log: string[] = [];
		let changes = 0;
		const path = new Path(() => changes++);
		const [a, b] = [holder("a", log), holder("b", log)];
		path.connected(linkOf("1"));
		path.attach(a);
		path.attach(b);
		path.detach(a);
		expect(changes).toBe(0);
		path.detach(b);
		expect(changes).toBe(1);
		expect(path.held).toBe(false);
		path.connected(linkOf("2"));
		expect(log).toEqual(["a@1", "b@1"]);
	});

	it("says what changed: a holder attached without a link, a drop, the last release; fails its holders waiting", () => {
		const events: string[] = [];
		const failed: string[] = [];
		const path = new Path((event) => events.push(event.kind));
		const a = {
			attach: () => {},
			dropped: () => {},
			unreachable: (error: { readonly message: string }) => void failed.push(error.message),
		} as unknown as Upstream;
		path.attach(a);
		path.unreachable(new ChordError({ code: "unavailable", message: "no worker" }));
		const link = linkOf("1");
		path.connected(link);
		path.disconnected(link);
		path.detach(a);
		expect(events).toEqual(["attached", "dropped", "released"]);
		expect(failed).toEqual(["no worker"]);
	});

	it("counts a join to a held holder as a request without a link (a failed route resolves again), none with one", () => {
		const events: string[] = [];
		const path = new Path((event) => events.push(event.kind));
		const a = holder("a", []);
		path.attach(a);
		path.requested(a);
		expect(events).toEqual(["attached", "attached"]);
		path.connected(linkOf("1"));
		path.requested(a);
		expect(events).toEqual(["attached", "attached"]);
	});

	it("tells whether its route suspended it; a path without a route never is", () => {
		let suspended = false;
		expect(new Path(() => {}).suspended).toBe(false);
		const routed = new Path(
			() => {},
			() => suspended,
		);
		expect(routed.suspended).toBe(false);
		suspended = true;
		expect(routed.suspended).toBe(true);
	});
});

describe("a gated path (slice 14 §2.3)", () => {
	/** A holder recording what it is told, and a link whose fences the test runs by hand. */
	function gated(admitted: Set<string>) {
		const log: string[] = [];
		const fences: (() => void)[] = [];
		const events: string[] = [];
		const made = (name: string): Upstream =>
			({
				name,
				attach: (link: { readonly name: string }) => void log.push(`${name}@${link.name}`),
				dropped: () => void log.push(`${name} dropped`),
				unreachable: () => void log.push(`${name} unreachable`),
				withheld: (cause: { readonly kind: string }) => void log.push(`${name} ${cause.kind}`),
				admitted: () => void log.push(`${name} admitted`),
			}) as unknown as Upstream;
		const gate = {
			joined: (holder: Upstream) => admitted.has((holder as unknown as { name: string }).name),
			left: (holder: Upstream) => void log.push(`${(holder as unknown as { name: string }).name} left`),
			unlinked: () => void events.push("unlinked"),
		};
		const path = new Path(({ kind }) => void events.push(kind), undefined, gate);
		const link = (name: string) =>
			({
				name,
				fence: (then: () => void) => {
					const entry = () => then();
					fences.push(entry);
					return () => void fences.splice(fences.indexOf(entry), 1);
				},
			}) as unknown as HostLink;
		return { log, fences, events, path, made, link };
	}

	const denied = { kind: "denied", error: new ChordError({ code: "forbidden", message: "no" }) } as const;

	it("holds only what its gate admits on its links, and wants a link only for those", () => {
		const { log, events, path, made, link } = gated(new Set(["a"]));
		const [a, b] = [made("a"), made("b")];
		path.attach(b);
		// Withheld: no link is asked for it.
		expect([events, path.held, path.wanted]).toEqual([[], true, false]);
		path.attach(a);
		expect([events, path.wanted]).toEqual([["attached"], true]);
		path.connected(link("1"));
		expect(log).toEqual(["a@1"]);
		path.forward(b);
		expect(log).toEqual(["a@1", "b admitted", "b@1"]);
		path.disconnected(path.link!);
		// Its gate is told after the holders, before the route: it may take back what it cannot forward on a new link.
		expect(events).toEqual(["attached", "unlinked", "dropped"]);
		path.unreachable(new ChordError({ code: "unavailable", message: "down" }));
		expect(log.slice(3)).toEqual(["b dropped", "a dropped", "b unreachable", "a unreachable"]);
		path.detach(a);
		expect(log.at(-1)).toBe("a left");
	});

	it("forwards a holder a denial released on the link only behind a fence; one never forwarded needs none", () => {
		const { log, fences, path, made, link } = gated(new Set(["a"]));
		const [a, b] = [made("a"), made("b")];
		path.attach(a);
		path.attach(b);
		path.connected(link("1"));
		path.withhold(a, denied);
		path.withhold(b, denied);
		expect(log).toEqual(["a@1", "a denied", "b denied"]);
		path.forward(b);
		path.forward(a);
		// `b` was never on the link: held at once. `a` is told it is admitted, and waits for its fence.
		expect([log.slice(3), fences.length]).toEqual([["b admitted", "b@1", "a admitted"], 1]);
		fences[0]!();
		expect(log.slice(6)).toEqual(["a@1"]);
		// Denied again and allowed: it was on the link again, so a new fence.
		path.withhold(a, denied);
		path.forward(a);
		expect(fences.length).toBe(2);
	});

	it("a holder its gate takes back when the link is lost wants no link, and is on none until it is forwarded again", () => {
		const { log, events, path, made, link } = gated(new Set(["a"]));
		const a = made("a");
		path.attach(a);
		const first = link("1");
		path.connected(first);
		path.disconnected(first);
		// What a gate does in `unlinked` when it cannot read an allow.
		path.withhold(a, { kind: "waiting", error: new ChordError({ code: "unavailable", message: "source failed" }) });
		expect([path.withholds(a), path.wanted]).toEqual([true, false]);
		path.connected(link("2"));
		expect(log).toEqual(["a@1", "a dropped", "a waiting"]);
		// Never on the second link: forwarded there with no fence.
		path.forward(a);
		expect(log.slice(3)).toEqual(["a admitted", "a@2"]);
		expect(events.filter((event) => event === "unlinked").length).toBe(1);
	});

	it("a denial before the fence ran cancels it; a lost link drops it, and the next link holds what is admitted", () => {
		const { log, fences, path, made, link } = gated(new Set(["a"]));
		const a = made("a");
		path.attach(a);
		const first = link("1");
		path.connected(first);
		path.withhold(a, denied);
		path.forward(a);
		path.withhold(a, denied);
		expect(fences.length).toBe(0);
		path.forward(a);
		expect(fences.length).toBe(1);
		path.disconnected(first);
		expect(fences.length).toBe(0);
		// Not held on the lost link (its fence was pending): not told of the drop twice, held on the next at once.
		path.connected(link("2"));
		expect(log).toEqual(["a@1", "a denied", "a admitted", "a denied", "a admitted", "a dropped", "a@2"]);
	});
});
