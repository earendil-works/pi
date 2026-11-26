// Kinds (`defineThing`, `expand`): the contract a kind declares (params `{ workspace, thing }` on the server, the
// things admission; a member no tick gives plain, the others grantable; flags with their labels), its data with the
// defaults, the declaration checked by its types and again at run time (for JavaScript callers), and tick names turned
// into members and flags, unknown ones giving nothing (R3).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memberNames, method, str } from "@earendil-works/p3/v1";
import { defineThing, expand } from "../kind.ts";

const label = (key: string) => ({ namespace: "test", key, params: [] });

const Kind = defineThing("test.kind", {
	version: 3,
	state: { title: str(), secret: str() },
	methods: { look: method(), change: method() },
	ticks: {
		see: { label: label("see"), for: "people", gives: ["secret"] },
		edit: { label: label("edit"), gives: ["change", "export"] },
		export: { label: label("export") },
	},
	defaultGrants: { everyone: ["see"] },
});

describe("a kind", () => {
	it("declares a remote contract of its members (those no tick gives plain, the others grantable), its flag ticks flags", () => {
		assert.equal(Kind.contract.name, "test.kind");
		assert.equal(Kind.contract.version, 3);
		const { state, methods, events } = memberNames(Kind.contract);
		assert.deepEqual([state.toSorted(), methods.toSorted(), events], [["secret", "title"], ["change", "look"], []]);
		assert.deepEqual([...Kind.all].sort(), ["change", "export", "secret"]);
	});

	it("carries its data with the defaults: many workspaces, made by its plugin, all stacking, ticks for all", () => {
		assert.deepEqual(Kind.info, {
			name: "test.kind",
			version: 3,
			workspaces: "many",
			makers: "plugin",
			stacking: "all",
			ticks: [
				{ name: "see", label: label("see"), for: "people" },
				{ name: "edit", label: label("edit"), for: "all" },
				{ name: "export", label: label("export"), for: "all" },
			],
			defaultGrants: { everyone: ["see"] },
			ticksVersion: 1,
		});
	});

	it("refuses a tick giving what the kind lacks, a flag tick named like a member, a default grant for the wrong party", () => {
		const declare = (declaration: object) =>
			(defineThing as (name: string, declaration: object) => unknown)("test.bad", {
				version: 1,
				methods: { look: method() },
				...declaration,
			});
		assert.throws(
			() => declare({ ticks: { see: { label: label("see"), gives: ["peek"] } } }),
			/"peek" is no member or flag tick/,
		);
		assert.throws(() => declare({ ticks: { look: { label: label("look") } } }), /a flag tick is named like a member/);
		// A tick gives members and flag ticks only, never a tick that gives of its own (decision 97).
		assert.throws(
			() =>
				declare({
					ticks: { a: { label: label("a"), gives: ["b"] }, b: { label: label("b"), gives: ["look"] } },
				}),
			/"b" is no member or flag tick/,
		);
		assert.throws(
			() =>
				declare({
					ticks: { bash: { label: label("bash"), for: "agents", gives: ["look"] } },
					defaultGrants: { everyone: ["bash"] },
				}),
			/defaultGrants.everyone: "bash" is no tick for everyone/,
		);
		// A member or flag tick in several ticks is fine; a member no tick gives is plain.
		const both = defineThing("test.both", {
			version: 1,
			methods: { look: method(), plain: method() },
			ticks: {
				a: { label: label("a"), gives: ["look", "f"] },
				b: { label: label("b"), gives: ["look", "f"] },
				f: { label: label("f") },
			},
		});
		assert.deepEqual(both.all.toSorted(), ["f", "look"]);
		// A member in two ticks is lost only when both are gone.
		assert.deepEqual(expand(both, ["b"]).toSorted(), ["f", "look"]);
		assert.deepEqual(expand(both, []), []);
	});

	it("types its declaration: what a tick gives, what a default grant names, which names are grantable", () => {
		const typed = (declare: () => unknown) => assert.throws(declare);
		typed(() =>
			defineThing("test.typed", {
				version: 1,
				methods: { look: method() },
				// @ts-expect-error: "peek" is no member or flag tick.
				ticks: { see: { label: label("see"), gives: ["peek"] } },
			}),
		);
		typed(() =>
			defineThing("test.typed", {
				version: 1,
				methods: { look: method() },
				// @ts-expect-error: `b` gives of its own, so it is no flag tick another tick can give.
				ticks: { a: { label: label("a"), gives: ["b"] }, b: { label: label("b"), gives: ["look"] } },
			}),
		);
		typed(() =>
			defineThing("test.typed", {
				version: 1,
				methods: { look: method() },
				ticks: { see: { label: label("see"), gives: ["look"] } },
				// @ts-expect-error: "fly" is no tick of the kind.
				defaultGrants: { everyone: ["fly"] },
			}),
		);
		const grantable: readonly ("change" | "export" | "secret")[] = Kind.all;
		assert.equal(grantable.length, 3);
		// @ts-expect-error: `title` no tick gives: it is plain, never granted.
		const plain: (typeof Kind.all)[number] = "title";
		assert.equal(plain, "title");
	});

	it("expands tick names into the members and flags they give, each once; an unknown tick gives nothing", () => {
		assert.deepEqual(expand(Kind, ["edit", "see", "edit"]).sort(), ["change", "export", "secret"]);
		// A flag tick gives itself.
		assert.deepEqual(expand(Kind, ["export"]), ["export"]);
		assert.deepEqual(expand(Kind, ["fly"]), []);
	});
});
