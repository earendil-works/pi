import { describe, expect, it } from "vitest";
import {
	cleanStepText,
	extractDoneSteps,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "../examples/extensions/plan-mode/utils.ts";

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

	describe("edge cases", () => {
		it("requires command to be in safe list (not just non-destructive)", () => {
			expect(isSafeCommand("unknown-command")).toBe(false);
			expect(isSafeCommand("my-script.sh")).toBe(false);
		});

		it("handles commands with leading whitespace", () => {
			expect(isSafeCommand("  ls -la")).toBe(true);
			expect(isSafeCommand("  rm file")).toBe(false);
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

	it("truncates long text", () => {
		const longText = "This is a very long step description that exceeds the maximum allowed length for display";
		const result = cleanStepText(longText);
		expect(result.length).toBe(50);
		expect(result.endsWith("...")).toBe(true);
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
		expect(items[0].text).toContain("proper");
	});

	it("filters out code-like items", () => {
		const message = `Plan:
1. \`npm install\`
2. Run the build process`;

		const items = extractTodoItems(message);
		expect(items).toHaveLength(1);
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
