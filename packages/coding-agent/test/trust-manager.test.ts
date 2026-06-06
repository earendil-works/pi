import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasProjectTrustInputs, ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions per cwd", () => {
		const store = new ProjectTrustStore(agentDir);

		expect(store.get(cwd)).toBeNull();
		store.set(cwd, true);
		expect(store.get(cwd)).toBe(true);
		store.set(cwd, false);
		expect(store.get(cwd)).toBe(false);
		store.set(cwd, null);
		expect(store.get(cwd)).toBeNull();
	});

	it("fails loudly without overwriting malformed trust stores", () => {
		const trustPath = join(agentDir, "trust.json");
		writeFileSync(trustPath, "{not json", "utf-8");
		const store = new ProjectTrustStore(agentDir);

		expect(() => store.get(cwd)).toThrow(/Failed to read trust store/);
		expect(() => store.set(cwd, true)).toThrow(/Failed to read trust store/);
		expect(readFileSync(trustPath, "utf-8")).toBe("{not json");
	});

	it("detects project trust inputs", () => {
		expect(hasProjectTrustInputs(cwd)).toBe(false);

		mkdirSync(join(cwd, ".pi"), { recursive: true });
		expect(hasProjectTrustInputs(cwd)).toBe(true);
		rmSync(join(cwd, ".pi"), { recursive: true, force: true });

		writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
		expect(hasProjectTrustInputs(cwd)).toBe(true);
		rmSync(join(cwd, "AGENTS.md"), { force: true });

		mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
		expect(hasProjectTrustInputs(cwd)).toBe(true);
	});
});
