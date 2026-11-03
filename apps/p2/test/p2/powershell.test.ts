// The powershell plugin's per-agent choice (Pi Mobile's offerPowerShell, per agent location): Durable's deferred
// `powershell` tool is offered to an agent by its own tool selection, leaving its other choices alone. The decision from
// each agent's machine is covered by relocate-worker.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentState } from "@earendil-works/pi-durable";
import { offersPowerShell, setPowerShell } from "../../plugins/powershell/worker.ts";

test("PowerShell is offered by an agent's own tool selection, other choices untouched", () => {
	// The main agent: every tool enabled, none loaded.
	const main: AgentState = {};
	assert.equal(offersPowerShell(main), false);
	setPowerShell(main, true);
	assert.deepEqual(main, { modelTools: { add: ["powershell"] } });
	assert.equal(offersPowerShell(main), true);
	setPowerShell(main, false);
	assert.deepEqual(main, { modelTools: {} });
	assert.equal(offersPowerShell(main), false);
	// A subagent: its chosen tools and the team tool it loads.
	const subagent: AgentState = { tools: ["bash", "team"], modelTools: { add: ["team"] } };
	setPowerShell(subagent, true);
	assert.deepEqual(subagent, { tools: ["bash", "team", "powershell"], modelTools: { add: ["team", "powershell"] } });
	assert.equal(offersPowerShell(subagent), true);
	setPowerShell(subagent, false);
	assert.deepEqual(subagent, { tools: ["bash", "team"], modelTools: { add: ["team"] } });
	// Explicit arrays and removals.
	const listed: AgentState = { tools: { remove: ["powershell"] }, modelTools: ["read"] };
	setPowerShell(listed, true);
	assert.deepEqual(listed, { tools: { remove: [] }, modelTools: ["read", "powershell"] });
	assert.equal(offersPowerShell(listed), true);
});
