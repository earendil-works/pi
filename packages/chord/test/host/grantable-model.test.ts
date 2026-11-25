// Model-based randomized test of grantable members (slice 15 §1) across contract versions (design §27) and lifecycles
// (design §6, §7, §21). A seed generates a contract history (members added, changed, removed; plain and grantable;
// flags) and a local keyed contract's history, providers of any of their versions with generated `accepts`, consumers
// of any version on the provider's host and over a link, and a walk of steps: holds, releases, admissions (allow with
// granted subsets, deny with and without a message, equal decisions), reloads to another version (slow to open, or
// with a call running on the old provider and calls made meanwhile), the provider removed and back, objects failing
// live and retried, link drops, value changes, key writes, emits and calls. After every step each reference is
// compared with the model (`grantable-model/model.ts`), and the runner checks the invariants: one state object while
// nothing changes, every state change notified, one frame per change, objects living exactly while held, waiting
// references on the unbound clock. A failure is shrunk to a minimal case and printed with its seed.
//
// Runs: GRANTABLE_SEEDS (how many, default 25), GRANTABLE_FIRST_SEED (default 1), GRANTABLE_SEED (one seed),
// GRANTABLE_STEPS (steps per seed, default 30); case sizes GRANTABLE_MAX_VERSIONS (4), GRANTABLE_MAX_MEMBERS (6),
// GRANTABLE_MAX_EDITS (edits per version, 3), GRANTABLE_MAX_HOLDS (consumers held at once, 6). A long hunt:
// GRANTABLE_SEEDS=2000 GRANTABLE_STEPS=80 GRANTABLE_MAX_VERSIONS=7 GRANTABLE_MAX_MEMBERS=9 GRANTABLE_MAX_HOLDS=8.

import { describe, expect, it } from "vitest";
import type { Case, Decision, Edit, PoolMember, Shape, Step, Who } from "./grantable-model/case.ts";
import { describeCase, generate, type Limits, shrink } from "./grantable-model/generate.ts";
import { run } from "./grantable-model/runner.ts";

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const ONE_SEED = process.env.GRANTABLE_SEED;
const FIRST = ONE_SEED === undefined ? env("GRANTABLE_FIRST_SEED", 1) : Number(ONE_SEED);
const SEEDS = ONE_SEED === undefined ? env("GRANTABLE_SEEDS", 25) : 1;
const STEPS = env("GRANTABLE_STEPS", 30);
const LIMITS: Limits = {
	versions: env("GRANTABLE_MAX_VERSIONS", 4),
	members: env("GRANTABLE_MAX_MEMBERS", 6),
	edits: env("GRANTABLE_MAX_EDITS", 3),
	holds: env("GRANTABLE_MAX_HOLDS", 6),
};

/**
 * Findings not fixed yet, by the name of their case below (expected to fail until the fix lands, then removed), and
 * the default seeds that fail only because of them (skipped until then).
 */
const OPEN: Readonly<Record<string, string>> = {};
const OPEN_SEEDS: Readonly<Record<number, string>> = {};

describe("grantable members across versions and lifecycles, against the model", () => {
	it(`hold for seeds ${FIRST} to ${FIRST + SEEDS - 1} (${STEPS} steps each)`, async () => {
		const found: string[] = [];
		const categories = new Set<string>();
		for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
			if (OPEN_SEEDS[seed] !== undefined) continue;
			const spec = generate(seed, STEPS, LIMITS);
			const failure = await run(spec, seed);
			if (failure === undefined || categories.has(failure.category)) {
				if (failure !== undefined) found.push(`seed ${seed}: ${failure.category} (shrunk under an earlier seed)`);
				continue;
			}
			categories.add(failure.category);
			const small = await shrink(spec, failure, seed);
			const text = `seed ${seed}, step ${small.failure.step}, ${small.failure.category}:\n${small.failure.message}\n${describeCase(small.spec)}\n${JSON.stringify(small.spec)}`;
			console.log(text);
			found.push(text);
		}
		expect(found).toEqual([]);
	}, 600_000);
});

/** `spec` with the keyed contract's history `versions` (its members named `k…` keyed, `t…` plain). */
function withKeyed(spec: Case, versions: Edit[][]): Case {
	return { ...spec, keyed: { members: [...new Set(versions.flat().map(({ member }) => member))], versions } };
}

/** A case by hand: a history from `versions` (members named by kind letter, `g` suffix: grantable), and steps. */
function scenario(pool: string, versions: readonly (readonly Edit[])[], steps: readonly Step[]): Case {
	const members = pool
		.split(" ")
		.filter((name) => name !== "")
		.map(
			(name): PoolMember => ({
				name: name.replace(/g$/, ""),
				kind: name[0] === "s" ? "state" : name[0] === "e" ? "event" : "method",
				grantable: name.endsWith("g"),
			}),
		);
	return { pool: members, flags: ["f0"], versions, keyed: { members: [], versions: [[]] }, steps };
}

const S0: Shape = { a: 0, r: 0 };
const add = (member: string, shape = S0): Edit => ({ op: "add", member, shape });
const remove = (member: string): Edit => ({ op: "remove", member });
const change = (member: string, shape: Shape = { a: 1, r: 0 }): Edit => ({ op: "change", member, shape, sides: ["a"] });
const serve = (
	version: number,
	versions: number[] = [],
	choices: Record<string, "refuse" | "call"> = {},
	slow = false,
	busy = false,
): Step => ({ kind: "serve", version, accepts: { versions, choices }, slow, busy });
const hold = (id: number, version: number, at: "local" | "link"): Step => ({ kind: "hold", id, version, at });
const decide = (who: Who, decision: Decision): Step => ({ kind: "decide", who, decision });
const allowing = (...granted: string[]): Decision => ({ kind: "allow", granted });
const denying: Decision = { kind: "deny", reason: "no access" };

/** The minimal cases the seeds found, each a regression test. */
const REGRESSIONS: Readonly<Record<string, Case>> = {
	// Sol 1: a first denial clears the placeholders a reference has before its first binding.
	"a first denial removes the grantable members (over a link)": scenario(
		"m0g",
		[[add("m0")]],
		[hold(1, 1, "link"), decide("owner", denying), serve(1)],
	),
	"a first denial removes the grantable members (same host)": scenario(
		"e0g",
		[[add("e0")]],
		[serve(1), decide("server", denying), hold(1, 1, "local")],
	),
	// Sol 2: a same-host older binding is granted only the names its version has.
	"a same-host older binding is granted only its version's names": scenario(
		"m0g",
		[[], [add("m0")]],
		[decide("server", allowing("m0")), serve(2, [1]), hold(1, 1, "local")],
	),
	// Sol 3: a reference keeps its last grant while a replacement provider loads.
	"a reference keeps its grant while a replacement loads": scenario(
		"s0g",
		[[add("s0")]],
		[
			serve(1),
			decide("server", allowing("s0")),
			hold(1, 1, "local"),
			{ kind: "remove" },
			decide("server", allowing()),
			serve(1, [], {}, true),
		],
	),
	// A denied reference whose provider moves to a version that does not bind it waits, as a fresh hold of it does.
	"a denied reference waits once its version is not served (same host)": scenario(
		"",
		[[], []],
		[serve(2, [1]), decide("server", denying), hold(1, 2, "local"), serve(1)],
	),
	"a denied reference waits once its version is not served (over a link)": scenario(
		"",
		[[], []],
		[serve(2, [1]), decide("owner", denying), hold(1, 2, "link"), serve(1)],
	),
	// A reference that never bound has no grant: not the shared hold's it joins while the link is down.
	"a reference joining a hold while its link is down has no grant": scenario(
		"s0g",
		[[add("s0")]],
		[serve(1), decide("owner", allowing("s0")), hold(1, 1, "link"), { kind: "drop" }, hold(2, 1, "link")],
	),
	// A reference that never bound has no grant: not the object's when its version is refused a member.
	"a reference refused a member has no grant (same host)": scenario(
		"e0 s1g",
		[[add("e0"), add("s1")], [change("e0")]],
		[decide("server", allowing("s1")), serve(2, [1], { "1:e0": "refuse" }), hold(2, 2, "local"), hold(1, 1, "local")],
	),
	// A refused member refuses the version whatever the grant: the reference waits for a publication.
	"a reference refused a granted member waits whatever the grant (same host)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			decide("server", allowing("e0")),
			serve(2, [1], { "1:e0": "refuse" }),
			hold(1, 1, "local"),
			decide("server", allowing()),
		],
	),
	"a reference refused a granted member waits whatever the grant (over a link)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			decide("owner", allowing("e0")),
			serve(2, [1], { "1:e0": "refuse" }),
			hold(1, 1, "link"),
			decide("owner", allowing()),
		],
	),
	// A reference refused a member waits for a publication, through a denial too.
	"a reference refused a member keeps waiting through a denial": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[hold(1, 1, "link"), serve(2, [1], { "1:e0": "refuse" }), decide("owner", denying)],
	),
	// A reference waiting for its provider keeps its last grant when the provider comes back refusing it a member.
	"a removed provider's reference keeps its grant when the next one refuses it a member": scenario(
		"s0",
		[[add("s0")], [remove("s0")]],
		[
			decide("server", allowing("f0")),
			hold(1, 1, "local"),
			serve(1),
			{ kind: "remove" },
			serve(2, [1], { "1:s0": "refuse" }),
		],
	),
	// A reference that was never live keeps no value: none taken from an instance it never bound to.
	"a reference refused a member takes no value at a restart": scenario(
		"s0 s1",
		[
			[add("s0"), add("s1")],
			[remove("s0"), remove("s1")],
		],
		[
			hold(2, 2, "local"),
			serve(2, [1], { "1:s1": "refuse" }),
			hold(1, 1, "local"),
			serve(2, [1], { "1:s1": "refuse" }),
		],
	),
	// A reference that never bound has no grant, also after a restart of the provider that refuses it a member.
	"a reference refused a granted member has no grant after a restart (same host)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			hold(1, 1, "local"),
			decide("server", allowing("e0", "f0")),
			serve(2, [1], { "1:e0": "refuse" }),
			serve(2, [1], { "1:e0": "refuse" }),
		],
	),
	"a reference refused a granted member has no grant after a restart (over a link)": scenario(
		"e0g",
		[[add("e0")], [change("e0")]],
		[
			hold(1, 1, "link"),
			decide("owner", allowing("e0", "f0")),
			serve(2, [1], { "1:e0": "refuse" }),
			serve(2, [1], { "1:e0": "refuse" }),
		],
	),
	// A reload never throws: the provider's reload that stops accepting a refused reference's version.
	"a reload never throws when a refused reference's provider stops accepting its version": scenario(
		"s0",
		[[add("s0")], [remove("s0")]],
		[hold(1, 1, "link"), serve(2, [1], { "1:s0": "refuse" }), serve(1)],
	),
	// A reference that never bound has no grant, also after a reload that stops accepting its version.
	"a reference refused a member has no grant after a reload that stops accepting it (same host)": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[serve(2, [1], { "1:e0": "refuse" }), decide("server", allowing("f0")), hold(1, 1, "local"), serve(2)],
	),
	"a reference refused a member has no grant after a reload that stops accepting it (over a link)": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[serve(2, [1], { "1:e0": "refuse" }), decide("owner", allowing("f0")), hold(1, 1, "link"), serve(2)],
	),
	// A reference that was never live keeps no value, also after a reload that stops accepting its version.
	"a reference refused a member takes no value at a reload that stops accepting it": scenario(
		"s0 s1",
		[
			[add("s0"), add("s1")],
			[remove("s0"), remove("s1")],
		],
		[serve(2, [1], { "1:s1": "refuse" }), hold(1, 1, "local"), serve(2)],
	),
	// A denied reference whose provider is reloaded to refuse its version a member waits, as a fresh hold of it does.
	"a denied reference waits once a reload refuses its version a member (same host)": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[serve(2, [1]), hold(1, 1, "local"), decide("server", denying), serve(2, [1], { "1:e0": "refuse" })],
	),
	"a denied reference waits once a reload refuses its version a member (over a link)": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[serve(2, [1]), hold(1, 1, "link"), decide("owner", denying), serve(2, [1], { "1:e0": "refuse" })],
	),
	// Round 2 of the reviews (on 864a0e253), as the model finds them.
	"a call made at the reload's gate does not run once its version is refused": scenario(
		"s0 m1",
		[[add("s0"), add("m1")], [remove("s0")]],
		[serve(1), hold(1, 1, "local"), serve(2, [1], { "1:s0": "refuse" }, false, true)],
	),
	"a refused version's key watch takes no later write": withKeyed(
		scenario(
			"",
			[[]],
			[
				{ kind: "kserve", version: 1, accepts: { versions: [], choices: {} } },
				{ kind: "khold", id: 1, version: 1 },
				{ kind: "kput", member: "k0", key: "a", value: "one" },
				{ kind: "kserve", version: 2, accepts: { versions: [1], choices: { "1:t0": "refuse" } } },
				{ kind: "kput", member: "k0", key: "a", value: "two" },
			],
		),
		[[add("k0"), add("t0")], [remove("t0")]],
	),
	"a refused reference reads one state object": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[serve(2, [1], { "1:e0": "refuse" }), hold(1, 1, "local")],
	),
	"a denied object ends when its last holder's version is no longer served": scenario(
		"",
		[[], []],
		[serve(2, [1]), decide("server", denying), hold(1, 2, "local"), serve(1), { kind: "release", id: 1 }],
	),
	"a refused reference takes no value when the object fails": scenario(
		"s0 e1",
		[[add("s0"), add("e1")], [change("e1")]],
		[serve(2, [1], { "1:e1": "refuse" }), hold(2, 2, "local"), hold(1, 1, "local"), { kind: "break", who: "server" }],
	),
	"a refused reference is told each state while the successor opens": scenario(
		"e0",
		[[add("e0")], [change("e0")]],
		[
			serve(2, [1], { "1:e0": "refuse" }),
			hold(1, 1, "local"),
			hold(2, 1, "link"),
			serve(2, [1], { "1:e0": "refuse" }, true),
		],
	),
	"a refused reference gets one failure per reload (same host and over a link)": scenario(
		"e0 s1g",
		[[add("e0"), add("s1")], [change("e0")]],
		[
			decide("server", allowing("s1")),
			decide("owner", allowing("s1")),
			serve(2, [1], { "1:e0": "refuse" }),
			hold(1, 1, "local"),
			hold(2, 1, "link"),
			serve(2, [1], { "1:e0": "refuse" }),
		],
	),
	"refused references wait on the unbound clock": scenario(
		"s0 s1",
		[[add("s0"), add("s1")], [remove("s1")]],
		[serve(2, [1], { "1:s1": "refuse" }), hold(1, 1, "local"), hold(2, 1, "link")],
	),
};

describe("grantable members: minimal cases the model found", () => {
	for (const [name, spec] of Object.entries(REGRESSIONS)) {
		(OPEN[name] === undefined ? it : it.fails)(name, async () => {
			const failure = await run(spec);
			expect(failure && `${failure.category}: ${failure.message}\n${describeCase(spec)}`).toBeUndefined();
		});
	}
});
