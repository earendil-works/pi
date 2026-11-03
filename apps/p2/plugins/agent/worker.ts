// Code mode's one-shot `agent` tool, contributed unconditionally. Only scripts can call it (`callers: ["tools"]`), so
// without code mode nothing reaches it, and its prompt section renders only while a conversation can call both
// `codemode` and `agent`. Code mode stays independently removable: no import of its plugin. Its conversations are listed
// with the subagents (one-shot entries of their document), which is where their sidebar metadata and read-only rule live.

import type { Models } from "@earendil-works/pi-ai/models";
import { contribute, defineFacet } from "@p2/app/v1";
import { Extensions, HarnessConfig } from "@p2/app/v1/worker";
import { createAgentExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.agent-tool", (self) => {
		const config = self.registry(HarnessConfig);
		// The live model observer, as the subagent tool uses it: a phase captures the tool, not the model catalog.
		const models = new Proxy({} as Models, {
			get: (_target, key) => {
				const current = config.value.get("default")?.models();
				if (!current) throw new Error("No model configuration");
				const value: unknown = Reflect.get(current, key, current);
				return typeof value === "function" ? value.bind(current) : value;
			},
		});
		const extension = createAgentExtension(models);
		self.contribute(Extensions, { [extension.name]: extension });
	});
});
