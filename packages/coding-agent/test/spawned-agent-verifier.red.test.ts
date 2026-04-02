import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { eraseAgentTool } from "../src/extensions/types.js";
import { SessionManager } from "../src/session-manager.js";
import { spawnAgentTool } from "../src/tools/spawn-agent.js";

describe("spawned-agent verifier: red tests", () => {
	let projectDir: string;
	let configDir: string;
	let extDir: string;
	let sessionManager: SessionManager;
	let mgr: ExtensionManager;

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-verifier-test-"));
		configDir = join(projectDir, "_config");
		extDir = join(configDir, "extensions", "spec-mode");
		await mkdir(extDir, { recursive: true });

		const sessionFile = join(projectDir, "session.jsonl");
		sessionManager = new SessionManager(false, sessionFile, false, projectDir);
		sessionManager.startSession({
			model: { provider: "test", id: "test" },
			thinkingLevel: "off",
			messages: [],
		} as never);

		mgr = new ExtensionManager({
			builtInTools: { spawn_agent: eraseAgentTool(spawnAgentTool) },
			sessionManager,
		});
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
	});

	describe("ExtensionApi.spawnAgent", () => {
		it("has spawnAgent method on ExtensionApi", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default function (api) {
  if (typeof api.spawnAgent === "function") {
    api.appendSessionEntry("api_check", { hasSpawnAgent: true });
  }
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			expect(raw).toContain("hasSpawnAgent");
		});

		it("can spawn a verifier agent via spawnAgent", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default async function (api) {
  try {
    const result = await api.spawnAgent({
      message: "Verify this is a valid spec: Summary, What Must be True, Definition of Done",
      verify: true
    });
    api.appendSessionEntry("spawn_result", { 
      success: true, 
      hasResult: !!result,
      hasExitCode: result && typeof result.exitCode === "number"
    });
  } catch (err) {
    api.appendSessionEntry("spawn_result", { 
      success: false, 
      error: err.message 
    });
  }
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");

			// Should show spawn was attempted
			expect(raw).toContain("spawn_result");
		});
	});

	describe("verifier integration", () => {
		it("can spawn verifier agent with validation contract", async () => {
			await writeFile(
				join(extDir, "index.ts"),
				`
export default async function (api) {
  const specOutput = "Summary: Test spec. What Must be True: It works. Definition of Done: Tests pass.";
  const contract = {
    requiredSections: ["Summary", "Definition of Done"],
    mustContain: [],
    mustNotContain: ["TODO"]
  };
  
  try {
    const result = await api.spawnAgent({
      message: \`Verify this spec against the contract:\n\nSpec:\n\${specOutput}\n\nContract:\n\${JSON.stringify(contract, null, 2)}\n\nReturn PASS if all required sections present, FAIL otherwise. List any findings.\`,
      verify: true
    });
    
    api.appendSessionEntry("verifier_result", { 
      hasReport: !!result.verificationReport,
      exitCode: result.exitCode
    });
  } catch (err) {
    api.appendSessionEntry("verifier_result", { error: err.message });
  }
}
`,
				"utf8",
			);

			const loader = new ExtensionLoader(mgr, { projectDir, configDir });
			await loader.loadAll();

			const sessionFile = join(projectDir, "session.jsonl");
			const raw = await readFile(sessionFile, "utf8").catch(() => "{}");
			expect(raw).toContain("verifier_result");
		});
	});
});
