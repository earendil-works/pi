// The MCP lease rules (plugins/mcp/leases.ts): a generation sets exactly its locations, a newer generation takes the
// session over and refuses an older one, calls go through the setting incarnation's lease, and a view's end releases
// only its own generation's leases; each lease keeps the project configuration sent with its location.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Location } from "@p2/app/v1";
import { heldLease, type Lease, releaseGeneration, setLocations } from "../../plugins/mcp/leases.ts";

const A: Location = { env: null, cwd: "/a" };
const B: Location = { env: null, cwd: "/b" };
const GPU: Location = { env: "gpu", cwd: "/a" };
const NONE = { kind: "none" } as const;
const gen = (generation: number, incarnation = `i${generation}`) => ({ session: "s1", generation, incarnation });
const set = (leases: readonly Lease[], caller: ReturnType<typeof gen>, locations: Location[]) => {
	const result = setLocations(
		leases,
		caller,
		locations.map((location) => ({ location, project: NONE })),
	);
	assert.equal(result.kind, "set");
	return result.kind === "set" ? result.leases : [];
};

test("a generation leases exactly its locations; leaving one out ends its lease", () => {
	const other: Lease = { session: "s2", location: A, project: NONE, generation: 1, incarnation: "x" };
	const first = set([other], gen(1), [A, B, A]);
	assert.deepEqual(
		first.map((lease) => [lease.session, lease.location.cwd]),
		[
			["s2", "/a"],
			["s1", "/a"],
			["s1", "/b"],
		],
	);
	// The same location on another environment is another lease.
	assert.equal(set(first, gen(1), [A, GPU]).length, 3);
	const shrunk = set(first, gen(1), [B]);
	assert.deepEqual(
		shrunk.map((lease) => [lease.session, lease.location.cwd]),
		[
			["s2", "/a"],
			["s1", "/b"],
		],
	);
	assert.deepEqual(set(shrunk, gen(1), []), [other]);
});

test("a newer generation takes the session over; an older one is refused", () => {
	const older = set([], gen(1), [A, B]);
	const newer = set(older, gen(2), [A]);
	assert.deepEqual(
		newer.map((lease) => [lease.location.cwd, lease.generation]),
		[["/a", 2]],
	);
	assert.deepEqual(setLocations(newer, gen(1), [{ location: A, project: NONE }]), {
		kind: "refused",
		reason: "A newer worker of this session holds its MCP servers",
	});
	// Another incarnation of the same generation takes it over too (its calls then refuse the first one's).
	const again = set(newer, gen(2, "other"), [A]);
	assert.equal(heldLease(again, gen(2, "other"), A).kind, "held");
	assert.equal(heldLease(again, gen(2), A).kind, "stale");
	assert.equal(heldLease(again, gen(2, "other"), B).kind, "none");
});

test("a view's end releases only its generation's leases", () => {
	const leases = set([{ session: "s2", location: A, project: NONE, generation: 1, incarnation: "x" }], gen(2), [A]);
	assert.deepEqual(releaseGeneration(leases, "s1", 1), leases);
	assert.deepEqual(
		releaseGeneration(leases, "s1", 2).map((lease) => lease.session),
		["s2"],
	);
});

test("a lease keeps the project configuration sent with its location; of a location given twice, the first counts", () => {
	const file = { kind: "file", text: "{}" } as const;
	const result = setLocations([], gen(1), [
		{ location: A, project: file },
		{ location: A, project: NONE },
		{ location: B, project: { kind: "unreadable", error: "denied" } },
	]);
	assert.deepEqual(
		result.kind === "set" ? result.leases.map((lease) => [lease.location.cwd, lease.project.kind]) : [],
		[
			["/a", "file"],
			["/b", "unreadable"],
		],
	);
});
