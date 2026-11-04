// The codemode worker facet: its extension (the tool and its section), the `codemode` setting's switch, and the
// extension following the plugin across a reload and a removal. Scripts across a reload: codemode.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import codemodeWorker from "../../plugins/codemode/worker.ts";
import { WorkerModels } from "../../plugins/models/contract.ts";
import type { Ctx } from "../../src/runtime/chord.ts";
import { Session } from "../../src/runtime/chord.ts";
import { ExtensionSwitches } from "../../src/runtime/durable.ts";
import type { MobileSettings } from "../../src/runtime/settings.ts";
import { Extensions, type HarnessParts } from "../../src/runtime/worker.ts";
import { poll, testHost, workerFacet } from "./helpers.ts";

describe("codemode plugin", () => {
	it("registers its extension, follows the setting, and follows the plugin across a reload and a removal", async (t) => {
		let set: ((value: MobileSettings, ctx: Ctx) => void) | undefined;
		// No tool call runs here, so the Harness is never used.
		const natives = workerFacet({ harness: {} as HarnessParts });
		const fixture = await testHost({
			address: Session({ id: "codemode" }),
			kind: "worker",
			facets: [natives, codemodeWorker],
			stubs: [
				[
					WorkerModels,
					(_params, _principal, self) => {
						const settings = self.state<MobileSettings>({});
						set = (value, ctx) => settings.replace(ctx, value);
						return { settings };
					},
				],
			],
		});
		t.after(() => fixture.close());
		const extensions = await fixture.host.registry(Extensions, BACKGROUND_CONTEXT);
		const switches = await fixture.host.registry(ExtensionSwitches, BACKGROUND_CONTEXT);
		const first = extensions.value.get("codemode");
		// The tool, with `models.*` behind internal tools only scripts call, and the section listing callable tools.
		assert.deepEqual(
			first?.tools?.map((tool) => [tool.name, tool.replay, tool.callers]),
			[
				["codemode", "safe", ["model"]],
				["pi.codemode.models.classify", undefined, ["tools"]],
				["pi.codemode.models.generateImages", undefined, ["tools"]],
			],
		);
		assert.deepEqual(
			first?.sections?.map((section) => section.key),
			["codemode"],
		);
		// The `codemode` setting's switch: on without a setting, off with `false`, the registration untouched.
		await poll(() => switches.value.get("codemode") === true, 5000, "the switch to be on");
		set?.({ codemode: false }, BACKGROUND_CONTEXT as Ctx);
		await poll(() => switches.value.get("codemode") === false, 5000, "the switch to follow the setting");
		assert.equal(extensions.value.get("codemode"), first);
		set?.({}, BACKGROUND_CONTEXT as Ctx);
		await poll(() => switches.value.get("codemode") === true, 5000, "the switch to follow the setting");

		// A reload with a new facet value replaces the extension.
		await fixture.reload([natives, { ...codemodeWorker }]);
		await poll(() => ![undefined, first].includes(extensions.value.get("codemode")), 5000, "the reloaded extension");

		// Removing the plugin removes the extension; loading it again brings it back.
		await fixture.reload([natives]);
		await poll(() => extensions.value.get("codemode") === undefined, 5000, "the extension to go");
		await fixture.reload([natives, codemodeWorker]);
		await poll(() => extensions.value.get("codemode") !== undefined, 5000, "the extension again");
	});
});
