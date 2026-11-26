// Kinds (`defineThing`, `expand`): the contract a kind declares (params `{ workspace, thing }` on the server, the
// things admission; a member no tick gives plain, the others grantable; flags with their labels), its data with the
// defaults, and tick names turned into members and flags, unknown ones giving nothing (R3).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memberNames, method, str } from "@earendil-works/p3/v1";
import { defineThing, expand } from "../kind.ts";

const label = (key: string) => ({ namespace: "test", key, params: [] });

const Kind = defineThing("test.kind", {
	version: 3,
	state: { title: str(), secret: str() },
	methods: { look: method(), change: method() },
	flags: { export: label("flagExport") },
	ticks: {
		see: { label: label("see"), for: "people", gives: ["secret"] },
		edit: { label: label("edit"), gives: ["change", "export"] },
	},
	defaultGrants: { everyone: ["see"] },
});

describe("a kind", () => {
	it("declares a remote contract of its members: those no tick gives plain, the others grantable, the flags", () => {
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
			workspace: "no",
			ticks: [
				{ name: "see", label: label("see"), for: "people" },
				{ name: "edit", label: label("edit"), for: "all" },
			],
			defaultGrants: { everyone: ["see"] },
		});
	});

	it("refuses a tick giving what the kind lacks, and a flag no tick gives (decision 95)", () => {
		const declare = (declaration: object) =>
			(defineThing as (name: string, declaration: object) => unknown)("test.bad", declaration);
		assert.throws(
			() =>
				declare({
					version: 1,
					methods: { look: method() },
					ticks: { see: { label: label("see"), gives: ["peek"] } },
				}),
			/"peek" is no member or flag/,
		);
		assert.throws(
			() =>
				declare({
					version: 1,
					methods: { look: method() },
					flags: { export: label("x") },
					ticks: { see: { label: label("see"), gives: ["look"] } },
				}),
			/flags.export: no tick gives it/,
		);
		// A member or flag in several ticks is fine; a member no tick gives is plain.
		const both = defineThing("test.both", {
			version: 1,
			methods: { look: method(), plain: method() },
			ticks: { a: { label: label("a"), gives: ["look"] }, b: { label: label("b"), gives: ["look"] } },
		});
		assert.deepEqual(both.all, ["look"]);
	});

	it("expands tick names into the members and flags they give, each once; an unknown tick gives nothing", () => {
		assert.deepEqual(expand(Kind, ["edit", "see", "edit"]).sort(), ["change", "export", "secret"]);
		assert.deepEqual(expand(Kind, ["fly"]), []);
	});
});
