import assert from "node:assert/strict";
import test from "node:test";
import { parseStartupTimings } from "./profile-coding-agent-node.mjs";

test("parseStartupTimings extracts namespaced decimal timing groups", () => {
	const timings = parseStartupTimings(`noise
--- Startup Timings: extensions ---
  resolve: 12.5ms
  TOTAL: 12.5ms
-----------------------------------

--- Startup Timings: main ---
  pre-main: 205.4ms
  createAgentSessionRuntime: 80.0ms
  TOTAL: 285.4ms
-----------------------------
`);

	assert.deepEqual([...timings], [
		["extensions/resolve", 12.5],
		["extensions/TOTAL", 12.5],
		["pre-main", 205.4],
		["createAgentSessionRuntime", 80],
		["TOTAL", 285.4],
	]);
});

test("parseStartupTimings supports the legacy unnamespaced format", () => {
	const timings = parseStartupTimings(`--- Startup Timings ---
  parseArgs: 3ms
  TOTAL: 3ms
------------------------
`);

	assert.deepEqual([...timings], [
		["parseArgs", 3],
		["TOTAL", 3],
	]);
});
