import { describe, expect, it } from "vitest";
import { bugTriagePrompt, executionPrompt } from "../examples/extensions/plan-mode/prompts.js";
import {
	auditToolCalls,
	extractFilePaths,
	generateVerificationChecks,
	inferStepAction,
} from "../examples/extensions/plan-mode/utils.js";

describe("inferStepAction", () => {
	it("detects create actions", () => {
		expect(inferStepAction("Create component Header.tsx")).toBe("create");
		expect(inferStepAction("New file src/utils.ts")).toBe("create");
		expect(inferStepAction("Scaffold the project structure")).toBe("create");
		expect(inferStepAction("Generate migration file")).toBe("create");
		expect(inferStepAction("Set up the database connection")).toBe("create");
		expect(inferStepAction("Initialize the project")).toBe("create");
	});

	it("detects edit actions", () => {
		expect(inferStepAction("Edit src/app.tsx")).toBe("edit");
		expect(inferStepAction("Modify the navbar component")).toBe("edit");
		expect(inferStepAction("Update the config file")).toBe("edit");
		expect(inferStepAction("Fix the broken import")).toBe("edit");
		expect(inferStepAction("Refactor the auth module")).toBe("edit");
		expect(inferStepAction("Adjust the grid layout")).toBe("edit");
		expect(inferStepAction("Rename the variable")).toBe("edit");
		expect(inferStepAction("Replace hardcoded values")).toBe("edit");
		expect(inferStepAction("Simplify the component")).toBe("edit");
	});

	it("detects delete actions", () => {
		expect(inferStepAction("Delete the unused file")).toBe("delete");
		expect(inferStepAction("Remove file old-config.ts")).toBe("delete");
		expect(inferStepAction("Clean up unused imports")).toBe("delete");
	});

	it("detects test actions", () => {
		expect(inferStepAction("Run tests to verify")).toBe("test");
		expect(inferStepAction("Test the authentication flow")).toBe("test");
		expect(inferStepAction("Verify the build passes")).toBe("test");
		expect(inferStepAction("Check the tests pass")).toBe("test");
		expect(inferStepAction("Validate the output")).toBe("test");
	});

	it("detects install actions", () => {
		expect(inferStepAction("Install dependencies")).toBe("install");
		expect(inferStepAction("Add dependency tailwindcss")).toBe("install");
		expect(inferStepAction("npm add react-query")).toBe("install");
	});

	it("detects read actions", () => {
		expect(inferStepAction("Read the config file")).toBe("read");
		expect(inferStepAction("Check the current state")).toBe("read");
		expect(inferStepAction("Review the existing code")).toBe("read");
		expect(inferStepAction("Inspect the logs")).toBe("read");
		expect(inferStepAction("Analyze the error output")).toBe("read");
	});

	it("returns general for ambiguous steps", () => {
		expect(inferStepAction("Do the thing")).toBe("general");
		expect(inferStepAction("Proceed with implementation")).toBe("general");
	});
});

describe("auditToolCalls", () => {
	it("passes when expected tools are used", () => {
		expect(auditToolCalls("Create component Header.tsx", ["read", "write"]).pass).toBe(true);
		expect(auditToolCalls("Edit src/app.tsx", ["read", "edit"]).pass).toBe(true);
		expect(auditToolCalls("Run tests", ["bash"]).pass).toBe(true);
		expect(auditToolCalls("Install tailwind", ["bash"]).pass).toBe(true);
	});

	it("fails when no expected tools are used", () => {
		const result = auditToolCalls("Create component Header.tsx", ["read", "grep"]);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain("write");
	});

	it("fails when no tools called at all for action steps", () => {
		const result = auditToolCalls("Edit the config", []);
		expect(result.pass).toBe(false);
		expect(result.reason).toContain("No tools called");
	});

	it("passes read/general steps regardless of tools", () => {
		expect(auditToolCalls("Review the code", []).pass).toBe(true);
		expect(auditToolCalls("Review the code", ["read"]).pass).toBe(true);
		expect(auditToolCalls("Do the thing", []).pass).toBe(true);
	});

	it("returns the inferred action", () => {
		expect(auditToolCalls("Create file", ["write"]).action).toBe("create");
		expect(auditToolCalls("Edit file", ["edit"]).action).toBe("edit");
		expect(auditToolCalls("Run tests", ["bash"]).action).toBe("test");
	});

	it("accepts bash as alternative for create steps", () => {
		// Some creates happen via bash (e.g. mkdir, npx create-next-app)
		expect(auditToolCalls("Create project structure", ["bash"]).pass).toBe(true);
	});

	it("accepts write as alternative for edit steps", () => {
		// Full file rewrites use write instead of edit
		expect(auditToolCalls("Edit src/app.tsx completely", ["read", "write"]).pass).toBe(true);
	});
});

describe("extractFilePaths", () => {
	it("extracts TypeScript/JavaScript paths", () => {
		expect(extractFilePaths("Edit src/app.tsx")).toEqual(["src/app.tsx"]);
		expect(extractFilePaths("Create components/Header.tsx and utils/api.ts")).toEqual([
			"components/Header.tsx",
			"utils/api.ts",
		]);
	});

	it("extracts paths with backticks", () => {
		expect(extractFilePaths("Edit `src/config.json` file")).toEqual(["src/config.json"]);
	});

	it("extracts various file types", () => {
		const text = "Update styles.css, config.json, and README.md";
		const paths = extractFilePaths(text);
		expect(paths).toContain("styles.css");
		expect(paths).toContain("config.json");
		expect(paths).toContain("README.md");
	});

	it("deduplicates paths", () => {
		expect(extractFilePaths("Read src/app.tsx then edit src/app.tsx")).toEqual(["src/app.tsx"]);
	});

	it("handles relative paths", () => {
		expect(extractFilePaths("Edit ./src/app.tsx")).toEqual(["./src/app.tsx"]);
	});

	it("returns empty for no paths", () => {
		expect(extractFilePaths("Run the tests")).toEqual([]);
		expect(extractFilePaths("Set up the project")).toEqual([]);
	});
});

describe("generateVerificationChecks", () => {
	it("generates file existence check for create steps", () => {
		const checks = generateVerificationChecks("Create src/components/Header.tsx");
		expect(checks.length).toBeGreaterThan(0);
		const fileCheck = checks.find((c) => c.description.includes("exists"));
		expect(fileCheck).toBeDefined();
		expect(fileCheck!.command).toBe("test");
		expect(fileCheck!.args).toContain("-f");
	});

	it("generates git diff check for edit steps", () => {
		const checks = generateVerificationChecks("Edit src/app.tsx");
		const diffCheck = checks.find((c) => c.description.includes("Git diff"));
		expect(diffCheck).toBeDefined();
		expect(diffCheck!.command).toBe("git");
		expect(diffCheck!.failOnEmpty).toBe(true);
	});

	it("generates file-not-exists check for delete steps", () => {
		const checks = generateVerificationChecks("Delete src/old-file.ts");
		const deleteCheck = checks.find((c) => c.description.includes("deleted"));
		expect(deleteCheck).toBeDefined();
		expect(deleteCheck!.args).toContain("!");
	});

	it("returns empty for steps without file paths", () => {
		expect(generateVerificationChecks("Run the tests")).toEqual([]);
		expect(generateVerificationChecks("Set up the project")).toEqual([]);
	});

	it("uses fullStepText for path extraction when provided", () => {
		const checks = generateVerificationChecks(
			"New component",
			"Create a new component at src/components/Hero.tsx with responsive layout",
		);
		const fileCheck = checks.find((c) => c.description.includes("Hero.tsx"));
		expect(fileCheck).toBeDefined();
	});
});

describe("executionPrompt", () => {
	const step = { step: 1, text: "Build the API endpoint", completed: false };
	const wave = { wave: 1, steps: [1, 2] };
	const remaining = [
		{ step: 2, text: "Write tests", completed: false },
		{ step: 3, text: "Update docs", completed: false },
	];

	it("produces output with step text and remaining list (backward compat, no sibling arg)", () => {
		const result = executionPrompt(step, wave, remaining);
		expect(result).toContain("Step 1");
		expect(result).toContain("Build the API endpoint");
		expect(result).toContain("Wave 1");
		expect(result).toContain("2. Write tests");
		expect(result).toContain("3. Update docs");
	});

	it("appends sibling context when provided as 4th arg", () => {
		const siblingCtx = "## Parallel Siblings\n- Step 2: Write tests";
		const result = executionPrompt(step, wave, remaining, siblingCtx);
		expect(result).toContain("Build the API endpoint");
		expect(result).toContain("Parallel Siblings");
		expect(result).toContain("Step 2: Write tests");
	});

	it("produces identical output with empty string 4th arg as with 3 args", () => {
		const withoutArg = executionPrompt(step, wave, remaining);
		const withEmptyArg = executionPrompt(step, wave, remaining, "");
		expect(withoutArg).toBe(withEmptyArg);
	});
});

describe("bugTriagePrompt", () => {
	it("contains debug agent delegation instruction", () => {
		const result = bugTriagePrompt("the login page is broken");
		expect(result).toContain("debug agent");
		expect(result).toContain("subagent");
	});

	it("contains the user prompt text", () => {
		const userMsg = "TypeError: Cannot read property 'map' of undefined";
		const result = bugTriagePrompt(userMsg);
		expect(result).toContain(userMsg);
	});

	it("references the debug agent methodology", () => {
		const result = bugTriagePrompt("something is broken");
		expect(result).toContain("5-7 hypotheses");
	});
});
