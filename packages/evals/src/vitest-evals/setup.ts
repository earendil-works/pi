import { afterEach } from "vitest";
import type {} from "vitest-evals";
import { recordEvalSessionArtifact } from "./artifacts.ts";

afterEach(async ({ task }) => {
	const run = task.meta.harness?.run;
	if (run) await recordEvalSessionArtifact(task, run);
});
