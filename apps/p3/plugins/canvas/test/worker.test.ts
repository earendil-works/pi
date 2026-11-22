// The canvas plugin on a session's worker (`testPlugin`): a `canvas.board` thing gives the agent `canvas_read`
// always and `canvas_draw` only when the agent's options say `draw`. That the tools reach the board through the
// agent's `call` and the server admits the agent by its own options is the end to end test's (`e2e.test.ts`) and
// the server's (`server.test.ts`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/p3/v1";
import { testPlugin } from "@earendil-works/p3/v1/testing";
import { ThingExtensions } from "@earendil-works/p3/v1/worker";
import { CanvasKind } from "../contract.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

describe("the agent's tools for a board", () => {
	it("are canvas_read, and canvas_draw only with draw", async () => {
		const t = await testPlugin(ROOT, { kind: "worker", session: "s" }, context);
		try {
			const [entry] = t.contributions(ThingExtensions);
			assert.equal(entry?.value.kind.name, CanvasKind.name);
			const agent = { session: "s", call: () => Promise.reject(new Error("no call")) };
			const tools = (draw: boolean) =>
				entry?.value
					.give({ thing: "b", ref: "", options: { draw } }, agent)
					.extension?.tools?.map((tool) => tool.name)
					.toSorted();
			assert.deepEqual(tools(true), ["canvas_draw", "canvas_read"]);
			assert.deepEqual(tools(false), ["canvas_read"]);
		} finally {
			await t.close(context);
		}
	});
});
