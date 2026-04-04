import { describe, expect, it } from "vitest";
import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	extractWavePlan,
	formatEscalationContext,
	formatSiblingContext,
	getPlanningWriteRestriction,
	isSafeCommand,
	isWithinPiDir,
	markCompletedSteps,
	selectRecentPlanFiles,
	type TodoItem,
} from "../examples/extensions/plan-mode/utils.js";

describe("isSafeCommand", () => {
	describe("safe commands", () => {
		it("allows basic read commands", () => {
			expect(isSafeCommand("ls -la")).toBe(true);
			expect(isSafeCommand("cat file.txt")).toBe(true);
			expect(isSafeCommand("head -n 10 file.txt")).toBe(true);
			expect(isSafeCommand("tail -f log.txt")).toBe(true);
			expect(isSafeCommand("grep pattern file")).toBe(true);
			expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
		});

		it("allows git read commands", () => {
			expect(isSafeCommand("git status")).toBe(true);
			expect(isSafeCommand("git log --oneline")).toBe(true);
			expect(isSafeCommand("git diff")).toBe(true);
			expect(isSafeCommand("git branch")).toBe(true);
		});

		it("allows npm/yarn read commands", () => {
			expect(isSafeCommand("npm list")).toBe(true);
			expect(isSafeCommand("npm outdated")).toBe(true);
			expect(isSafeCommand("yarn info react")).toBe(true);
		});

		it("allows other safe commands", () => {
			expect(isSafeCommand("pwd")).toBe(true);
			expect(isSafeCommand("echo hello")).toBe(true);
			expect(isSafeCommand("wc -l file.txt")).toBe(true);
			expect(isSafeCommand("du -sh .")).toBe(true);
			expect(isSafeCommand("df -h")).toBe(true);
		});
	});

	describe("destructive commands", () => {
		it("blocks file modification commands", () => {
			expect(isSafeCommand("rm file.txt")).toBe(false);
			expect(isSafeCommand("rm -rf dir")).toBe(false);
			expect(isSafeCommand("mv old new")).toBe(false);
			expect(isSafeCommand("cp src dst")).toBe(false);
			expect(isSafeCommand("mkdir newdir")).toBe(false);
			expect(isSafeCommand("touch newfile")).toBe(false);
		});

		it("blocks git write commands", () => {
			expect(isSafeCommand("git add .")).toBe(false);
			expect(isSafeCommand("git commit -m 'msg'")).toBe(false);
			expect(isSafeCommand("git push")).toBe(false);
			expect(isSafeCommand("git checkout main")).toBe(false);
			expect(isSafeCommand("git reset --hard")).toBe(false);
		});

		it("blocks package manager installs", () => {
			expect(isSafeCommand("npm install lodash")).toBe(false);
			expect(isSafeCommand("yarn add react")).toBe(false);
			expect(isSafeCommand("pip install requests")).toBe(false);
			expect(isSafeCommand("brew install node")).toBe(false);
		});

		it("blocks redirects", () => {
			expect(isSafeCommand("echo hello > file.txt")).toBe(false);
			expect(isSafeCommand("cat foo >> bar")).toBe(false);
			expect(isSafeCommand(">file.txt")).toBe(false);
		});

		it("allows redirects to /dev/null and fd merges", () => {
			expect(isSafeCommand("ls vercel.json 2>/dev/null")).toBe(true);
			expect(isSafeCommand("ls foo 1>/dev/null")).toBe(true);
			expect(isSafeCommand("ls foo >/dev/null")).toBe(true);
			expect(isSafeCommand("node --test 2>&1 | tail -40")).toBe(true);
			expect(isSafeCommand("cd /Users/besi/Code/poly && node --test src/live/*.test.js 2>&1 | tail -40")).toBe(true);
		});

		it("blocks dangerous commands", () => {
			expect(isSafeCommand("sudo rm -rf /")).toBe(false);
			expect(isSafeCommand("kill -9 1234")).toBe(false);
			expect(isSafeCommand("reboot")).toBe(false);
		});

		it("blocks editors", () => {
			expect(isSafeCommand("vim file.txt")).toBe(false);
			expect(isSafeCommand("nano file.txt")).toBe(false);
			expect(isSafeCommand("code .")).toBe(false);
		});
	});

	describe("compound commands", () => {
		it("allows safe compound commands with &&", () => {
			expect(isSafeCommand("cd /path && git diff --stat")).toBe(true);
			expect(isSafeCommand("cd /path && ls -la")).toBe(true);
			expect(isSafeCommand("git status && git log --oneline")).toBe(true);
		});

		it("blocks compound commands with any destructive part", () => {
			expect(isSafeCommand("cd /path && rm -rf .")).toBe(false);
			expect(isSafeCommand("ls -la && git push")).toBe(false);
			expect(isSafeCommand("git status && npm install lodash")).toBe(false);
		});

		it("handles pipes", () => {
			expect(isSafeCommand("cat file.txt | grep pattern")).toBe(true);
			expect(isSafeCommand("ls -la | wc -l")).toBe(true);
		});

		it("handles semicolons", () => {
			expect(isSafeCommand("cd /path; git diff")).toBe(true);
			expect(isSafeCommand("cd /path; rm file")).toBe(false);
		});

		it("handles ||", () => {
			expect(isSafeCommand("cat file.txt || echo fallback")).toBe(true);
			expect(isSafeCommand("cat file.txt || rm file")).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("allows non-destructive commands (blocklist approach)", () => {
			expect(isSafeCommand("unknown-command")).toBe(true);
			expect(isSafeCommand("my-script.sh")).toBe(true);
			expect(isSafeCommand("node --test src/*.test.js")).toBe(true);
			expect(isSafeCommand("python --version")).toBe(true);
		});

		it("handles commands with leading whitespace", () => {
			expect(isSafeCommand("  ls -la")).toBe(true);
			expect(isSafeCommand("  rm file")).toBe(false);
		});

		it("allows cd as safe command", () => {
			expect(isSafeCommand("cd /some/path")).toBe(true);
			expect(isSafeCommand("cd ..")).toBe(true);
		});

		it("does not false-positive on destructive words in paths", () => {
			expect(isSafeCommand("find /Users/besi/Code/dd-trace")).toBe(true);
			expect(isSafeCommand("head /var/log/sudo.log")).toBe(true);
			expect(isSafeCommand("cat /Users/besi/touch-events/main.js")).toBe(true);
			expect(isSafeCommand("ls /Users/besi/mkdir-test-results/")).toBe(true);
			expect(isSafeCommand("ls /Users/besi/Code/reboot-scheduler/")).toBe(true);
			expect(isSafeCommand("cat /Users/besi/shutdown-notes.md")).toBe(true);
			expect(isSafeCommand("cd /Users/besi/Code/copy-tool && ls")).toBe(true);
		});
	});
});

describe("cleanStepText", () => {
	it("removes markdown bold/italic", () => {
		expect(cleanStepText("**bold text**")).toBe("Bold text");
		expect(cleanStepText("*italic text*")).toBe("Italic text");
	});

	it("removes markdown code", () => {
		expect(cleanStepText("run `npm install`")).toBe("Npm install"); // "run" is stripped as action word
		expect(cleanStepText("check the `config.json` file")).toBe("Config.json file");
	});

	it("removes leading action words", () => {
		expect(cleanStepText("Create the new file")).toBe("New file");
		expect(cleanStepText("Run the tests")).toBe("Tests");
		expect(cleanStepText("Check the status")).toBe("Status");
	});

	it("capitalizes first letter", () => {
		expect(cleanStepText("update config")).toBe("Config");
	});

	it("preserves long text", () => {
		const longText = "This is a very long step description that exceeds the maximum allowed length for display";
		const result = cleanStepText(longText);
		expect(result).toBe("This is a very long step description that exceeds the maximum allowed length for display");
	});

	it("normalizes whitespace", () => {
		expect(cleanStepText("multiple   spaces   here")).toBe("Multiple spaces here");
	});
});

describe("extractTodoItems", () => {
	it("extracts numbered items after Plan: header", () => {
		const message = `Here's what we'll do:

Plan:
1. First step here
2. Second step here
3. Third step here`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(3);
		expect(items[0].step).toBe(1);
		expect(items[0].text).toBe("First step here");
		expect(items[0].completed).toBe(false);
	});

	it("handles bold Plan header", () => {
		const message = `**Plan:**
1. Do something`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(1);
	});

	it("handles parenthesis-style numbering", () => {
		const message = `Plan:
1) First item
2) Second item`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(2);
	});

	it("returns empty array without Plan header", () => {
		const message = `Here are some steps:
1. First step
2. Second step`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(0);
	});

	it("filters out short items", () => {
		const message = `Plan:
1. OK
2. This is a proper step`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(1);
		expect(items[0].step).toBe(2); // preserves original plan step number
		expect(items[0].text).toContain("proper");
	});

	it("filters out code-like items", () => {
		const message = `Plan:
1. \`npm install\`
2. Run the build process`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(1);
		expect(items[0].step).toBe(2); // preserves original plan step number
	});

	it("preserves full step text for long items", () => {
		const message = `Plan:
1. Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(1);
		expect(items[0].text).toBe(
			"Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget",
		);
		expect(items[0].text).not.toContain("...");
	});
});

describe("extractDoneSteps", () => {
	it("extracts single DONE marker", () => {
		const message = "I've completed the first step [DONE:1]";
		expect(extractDoneSteps(message)).toEqual([1]);
	});

	it("extracts multiple DONE markers", () => {
		const message = "Did steps [DONE:1] and [DONE:2] and [DONE:3]";
		expect(extractDoneSteps(message)).toEqual([1, 2, 3]);
	});

	it("handles case insensitivity", () => {
		const message = "[done:1] [DONE:2] [Done:3]";
		expect(extractDoneSteps(message)).toEqual([1, 2, 3]);
	});

	it("returns empty array with no markers", () => {
		const message = "No markers here";
		expect(extractDoneSteps(message)).toEqual([]);
	});

	it("ignores malformed markers", () => {
		const message = "[DONE:abc] [DONE:] [DONE:1]";
		expect(extractDoneSteps(message)).toEqual([1]);
	});
});

describe("markCompletedSteps", () => {
	it("marks matching items as completed", () => {
		const items: TodoItem[] = [
			{ step: 1, text: "First", completed: false },
			{ step: 2, text: "Second", completed: false },
			{ step: 3, text: "Third", completed: false },
		];

		const count = markCompletedSteps("[DONE:1] [DONE:3]", items);

		expect(count).toBe(2);
		expect(items[0].completed).toBe(true);
		expect(items[1].completed).toBe(false);
		expect(items[2].completed).toBe(true);
	});

	it("returns count of completed items", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: false }];

		expect(markCompletedSteps("[DONE:1]", items)).toBe(1);
		expect(markCompletedSteps("no markers", items)).toBe(0);
	});

	it("ignores markers for non-existent steps", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: false }];

		const count = markCompletedSteps("[DONE:99]", items);

		expect(count).toBe(1); // Still counts the marker found
		expect(items[0].completed).toBe(false); // But doesn't mark anything
	});

	it("doesn't double-complete already completed items", () => {
		const items: TodoItem[] = [{ step: 1, text: "First", completed: true }];

		markCompletedSteps("[DONE:1]", items);
		expect(items[0].completed).toBe(true);
	});
});

describe("selectRecentPlanFiles", () => {
	it("prioritizes preferred paths when they are recent", () => {
		const files = [
			{ path: "/repo/.pi/plans/a.md", mtimeMs: 1000 },
			{ path: "/repo/.pi/plans/b.md", mtimeMs: 2000 },
			{ path: "/repo/.pi/plans/c.md", mtimeMs: 3000 },
		];

		const selected = selectRecentPlanFiles(files, 0, ["/repo/.pi/plans/b.md"]);
		expect(selected).toEqual(["/repo/.pi/plans/b.md", "/repo/.pi/plans/c.md", "/repo/.pi/plans/a.md"]);
	});

	it("excludes stale files older than prompt start", () => {
		const files = [
			{ path: "/repo/.pi/plans/old.md", mtimeMs: 1000 },
			{ path: "/repo/.pi/plans/new.md", mtimeMs: 5000 },
		];

		const selected = selectRecentPlanFiles(files, 4000, ["/repo/.pi/plans/old.md"]);
		expect(selected).toEqual(["/repo/.pi/plans/new.md"]);
	});

	it("deduplicates preferred paths", () => {
		const files = [
			{ path: "/repo/.pi/plans/a.md", mtimeMs: 1000 },
			{ path: "/repo/.pi/plans/b.md", mtimeMs: 2000 },
		];

		const selected = selectRecentPlanFiles(files, 0, ["/repo/.pi/plans/b.md", "/repo/.pi/plans/b.md"]);
		expect(selected).toEqual(["/repo/.pi/plans/b.md", "/repo/.pi/plans/a.md"]);
	});
});

describe("isWithinPiDir", () => {
	it("allows paths inside .pi/", () => {
		expect(isWithinPiDir(".pi/plans/test.md", "/project")).toBe(true);
		expect(isWithinPiDir("/project/.pi/drafts/foo.md", "/project")).toBe(true);
		expect(isWithinPiDir(".pi/agents/metis.md", "/project")).toBe(true);
	});

	it("blocks paths outside .pi/", () => {
		expect(isWithinPiDir("src/index.ts", "/project")).toBe(false);
		expect(isWithinPiDir("/project/src/index.ts", "/project")).toBe(false);
		expect(isWithinPiDir("../other/.pi/plans/test.md", "/project")).toBe(false);
	});

	it("blocks paths that look like .pi but aren't", () => {
		expect(isWithinPiDir(".pi-other/file.md", "/project")).toBe(false);
		expect(isWithinPiDir(".pipeline/file.md", "/project")).toBe(false);
	});
});

describe("getPlanningWriteRestriction", () => {
	it("allows markdown files under .pi/", () => {
		expect(getPlanningWriteRestriction(".pi/plans/test.md", "/project")).toBeNull();
	});

	it("allows .machine.ts files under .pi/machines/", () => {
		expect(getPlanningWriteRestriction(".pi/machines/foo.machine.ts", "/project")).toBeNull();
	});

	it("blocks .machine.js files with a tla-precheck-specific explanation", () => {
		const result = getPlanningWriteRestriction(".pi/machines/foo.machine.js", "/project");
		expect(result).toContain('".machine.js"');
		expect(result).toContain("tla-precheck subagent");
	});

	it("blocks non-markdown planning files outside the machine spec allowlist", () => {
		const result = getPlanningWriteRestriction(".pi/machines/foo.txt", "/project");
		expect(result).toContain("only .md files or .pi/machines/*.machine.ts files are allowed");
	});
});

describe("extractWavePlan", () => {
	it("extracts plan with explicit wave headers", () => {
		const plan = `# Build Dashboard

## Execution Strategy

### Wave 1 (Foundation):
├── Task 1: Set up project structure
├── Task 2: Configure database

### Wave 2 (Core):
├── Task 3: Build API endpoints
├── Task 4: Create UI components
`;
		const result = extractWavePlan(plan);
		expect(result).not.toBeNull();
		expect(result!.title).toBe("Build Dashboard");
		expect(result!.waves).toHaveLength(2);
		expect(result!.waves[0].wave).toBe(1);
		expect(result!.waves[0].steps).toContain(1);
		expect(result!.waves[0].steps).toContain(2);
		expect(result!.waves[1].wave).toBe(2);
		expect(result!.waves[1].steps).toContain(3);
		expect(result!.waves[1].steps).toContain(4);
		expect(result!.todoItems).toHaveLength(4);
	});

	it("extracts plan with TODO section format", () => {
		const plan = `# Add Auth

## TODOs

- [ ] 1. Create auth middleware
  **Blocked By**: None
- [ ] 2. Add login endpoint
  **Blocked By**: 1
- [ ] 3. Add signup endpoint
  **Blocked By**: 1
- [ ] 4. Write integration tests
  **Blocked By**: 2, 3
`;
		const result = extractWavePlan(plan);
		expect(result).not.toBeNull();
		expect(result!.todoItems).toHaveLength(4);
		expect(result!.steps[0].dependencies).toEqual([]);
		expect(result!.steps[1].dependencies).toEqual([1]);
		expect(result!.steps[3].dependencies).toEqual([2, 3]);
		// Should have multiple waves due to dependencies
		expect(result!.waves.length).toBeGreaterThan(1);
	});

	it("falls back to Plan: header format", () => {
		const plan = `Some context.

Plan:
1. First step
2. Second step
3. Third step
`;
		const result = extractWavePlan(plan);
		expect(result).not.toBeNull();
		expect(result!.todoItems).toHaveLength(3);
	});

	it("keeps long todo labels intact in TODO-section plans", () => {
		const plan = `# Recruitment

## TODOs

- [ ] 1. Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget
  **Blocked By**: None
`;
		const result = extractWavePlan(plan);
		expect(result).not.toBeNull();
		expect(result!.todoItems[0].text).toBe(
			"Wire candidate page state into the recruitment candidate hub and preserve the full label in the todo widget",
		);
		expect(result!.todoItems[0].text).not.toContain("...");
	});

	it("returns null for empty/unparseable text", () => {
		expect(extractWavePlan("Just some random text")).toBeNull();
		expect(extractWavePlan("")).toBeNull();
	});
});

describe("formatSiblingContext", () => {
	const step1: TodoItem = { step: 1, text: "Build API endpoint", completed: false };
	const step2: TodoItem = { step: 2, text: "Create database schema", completed: false };
	const step3: TodoItem = { step: 3, text: "Write integration tests", completed: false };

	it("returns empty string for empty array", () => {
		expect(formatSiblingContext(step1, [])).toBe("");
	});

	it("returns empty string for single-step array (no siblings)", () => {
		expect(formatSiblingContext(step1, [step1])).toBe("");
	});

	it("returns sibling list for 2-step array, excluding current", () => {
		const result = formatSiblingContext(step1, [step1, step2]);
		expect(result).toContain("Step 2");
		expect(result).toContain("Create database schema");
		expect(result).not.toContain("Step 1");
	});

	it("returns all siblings for 3+ step array", () => {
		const result = formatSiblingContext(step1, [step1, step2, step3]);
		expect(result).toContain("Step 2");
		expect(result).toContain("Step 3");
		expect(result).not.toContain("Step 1");
	});

	it("contains DO NOT duplicate and stubs guidance", () => {
		const result = formatSiblingContext(step1, [step1, step2]);
		expect(result).toContain("DO NOT duplicate");
		expect(result).toContain("stubs");
	});
});

describe("formatEscalationContext", () => {
	const step: TodoItem = { step: 3, text: "Fix the auth middleware", completed: false };

	it("contains step text, retry count, and max retries", () => {
		const result = formatEscalationContext(step, 1, 2, "Type error in auth.ts");
		expect(result).toContain("Step 3");
		expect(result).toContain("RETRY 1/2");
		expect(result).toContain("Fix the auth middleware");
	});

	it("contains error context verbatim", () => {
		const errorMsg = "TypeError: Cannot read properties of undefined (reading 'token')";
		const result = formatEscalationContext(step, 2, 2, errorMsg);
		expect(result).toContain(errorMsg);
	});
});
