import { describe, expect, it } from "vitest";
import type { HostLink } from "../../../src/next/remote/host-link.ts";
import { Path, type Upstream } from "../../../src/next/remote/path.ts";

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
});
