import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

describe("parseArgs", () => {
	describe("--version flag", () => {
		test("parses --version flag", () => {
			const result = parseArgs(["--version"]);
			expect(result.version).toBe(true);
		});

		test("parses -v shorthand", () => {
			const result = parseArgs(["-v"]);
			expect(result.version).toBe(true);
		});

		test("--version takes precedence over other args", () => {
			const result = parseArgs(["--version", "--help", "some message"]);
			expect(result.version).toBe(true);
			expect(result.help).toBe(true);
			expect(result.messages).toContain("some message");
		});
	});

	describe("--help flag", () => {
		test("parses --help flag", () => {
			const result = parseArgs(["--help"]);
			expect(result.help).toBe(true);
		});

		test("parses -h shorthand", () => {
			const result = parseArgs(["-h"]);
			expect(result.help).toBe(true);
		});
	});

	describe("--print flag", () => {
		test("parses --print flag", () => {
			const result = parseArgs(["--print"]);
			expect(result.print).toBe(true);
		});

		test("parses -p shorthand", () => {
			const result = parseArgs(["-p"]);
			expect(result.print).toBe(true);
		});

		test("parses prompt after -p even when it starts with YAML frontmatter", () => {
			const prompt = "---\ntitle: hello\n---\nSay hi.";
			const result = parseArgs(["-p", prompt]);
			expect(result.print).toBe(true);
			expect(result.messages).toEqual([prompt]);
			expect(result.unknownFlags.size).toBe(0);
		});

		test("does not consume options after -p as prompts", () => {
			const result = parseArgs(["-p", "--provider", "openai", "Say hi."]);
			expect(result.print).toBe(true);
			expect(result.provider).toBe("openai");
			expect(result.messages).toEqual(["Say hi."]);
		});
	});

	describe("--continue flag", () => {
		test("parses --continue flag", () => {
			const result = parseArgs(["--continue"]);
			expect(result.continue).toBe(true);
		});

		test("parses -c shorthand", () => {
			const result = parseArgs(["-c"]);
			expect(result.continue).toBe(true);
		});
	});

	describe("--resume flag", () => {
		test("parses --resume flag", () => {
			const result = parseArgs(["--resume"]);
			expect(result.resume).toBe(true);
		});

		test("parses -r shorthand", () => {
			const result = parseArgs(["-r"]);
			expect(result.resume).toBe(true);
		});
	});

	describe("flags with values", () => {
		test("parses --provider", () => {
			const result = parseArgs(["--provider", "openai"]);
			expect(result.provider).toBe("openai");
		});

		test("parses --model", () => {
			const result = parseArgs(["--model", "gpt-4o"]);
			expect(result.model).toBe("gpt-4o");
		});

		test("parses --api-key", () => {
			const result = parseArgs(["--api-key", "sk-test-key"]);
			expect(result.apiKey).toBe("sk-test-key");
		});

		test("parses --system-prompt", () => {
			const result = parseArgs(["--system-prompt", "You are a helpful assistant"]);
			expect(result.systemPrompt).toBe("You are a helpful assistant");
		});

		test("parses --append-system-prompt", () => {
			const result = parseArgs(["--append-system-prompt", "Additional context"]);
			expect(result.appendSystemPrompt).toEqual(["Additional context"]);
		});

		test("parses multiple --append-system-prompt flags", () => {
			const result = parseArgs(["--append-system-prompt", "Context A", "--append-system-prompt", "Context B"]);
			expect(result.appendSystemPrompt).toEqual(["Context A", "Context B"]);
		});

		test("parses --mode", () => {
			const result = parseArgs(["--mode", "json"]);
			expect(result.mode).toBe("json");
		});

		test("parses --mode rpc", () => {
			const result = parseArgs(["--mode", "rpc"]);
			expect(result.mode).toBe("rpc");
		});

		test("parses --session", () => {
			const result = parseArgs(["--session", "/path/to/session.jsonl"]);
			expect(result.session).toBe("/path/to/session.jsonl");
		});

		test("parses --session-id", () => {
			const result = parseArgs(["--session-id", "orchestrated-session"]);
			expect(result.sessionId).toBe("orchestrated-session");
		});

		test("parses --fork", () => {
			const result = parseArgs(["--fork", "1234abcd"]);
			expect(result.fork).toBe("1234abcd");
			expect(result.messages).toEqual([]);
		});

		test("parses --export", () => {
			const result = parseArgs(["--export", "session.jsonl"]);
			expect(result.export).toBe("session.jsonl");
		});

		test("parses --thinking", () => {
			const result = parseArgs(["--thinking", "high"]);
			expect(result.thinking).toBe("high");
		});

		test("parses --models as comma-separated list", () => {
			const result = parseArgs(["--models", "gpt-4o,claude-sonnet,gemini-pro"]);
			expect(result.models).toEqual(["gpt-4o", "claude-sonnet", "gemini-pro"]);
		});
	});

	describe("--name flag", () => {
		test("parses --name flag with value", () => {
			const result = parseArgs(["--name", "my-session"]);
			expect(result.name).toBe("my-session");
		});

		test("parses -n shorthand", () => {
			const result = parseArgs(["-n", "quick-session"]);
			expect(result.name).toBe("quick-session");
		});

		test("preserves empty values for main validation", () => {
			const result = parseArgs(["--name", ""]);
			expect(result.name).toBe("");
		});

		test("reports missing value", () => {
			const result = parseArgs(["--name"]);
			expect(result.diagnostics).toEqual([{ type: "error", message: "--name requires a value" }]);
		});

		test("works alongside other flags", () => {
			const result = parseArgs(["--name", "named-run", "--print", "--model", "gpt-4o", "hello"]);
			expect(result.name).toBe("named-run");
			expect(result.print).toBe(true);
			expect(result.model).toBe("gpt-4o");
			expect(result.messages).toEqual(["hello"]);
		});
	});

	describe("--no-session flag", () => {
		test("parses --no-session flag", () => {
			const result = parseArgs(["--no-session"]);
			expect(result.noSession).toBe(true);
		});
	});

	describe("--extension flag", () => {
		test("parses single --extension", () => {
			const result = parseArgs(["--extension", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses -e shorthand", () => {
			const result = parseArgs(["-e", "./my-extension.ts"]);
			expect(result.extensions).toEqual(["./my-extension.ts"]);
		});

		test("parses multiple --extension flags", () => {
			const result = parseArgs(["--extension", "./ext1.ts", "-e", "./ext2.ts"]);
			expect(result.extensions).toEqual(["./ext1.ts", "./ext2.ts"]);
		});
	});

	describe("--no-extensions flag", () => {
		test("parses --no-extensions flag", () => {
			const result = parseArgs(["--no-extensions"]);
			expect(result.noExtensions).toBe(true);
		});

		test("parses --no-extensions with explicit -e flags", () => {
			const result = parseArgs(["--no-extensions", "-e", "foo.ts", "-e", "bar.ts"]);
			expect(result.noExtensions).toBe(true);
			expect(result.extensions).toEqual(["foo.ts", "bar.ts"]);
		});
	});

	describe("--skill flag", () => {
		test("parses single --skill", () => {
			const result = parseArgs(["--skill", "./skill-dir"]);
			expect(result.skills).toEqual(["./skill-dir"]);
		});

		test("parses multiple --skill flags", () => {
			const result = parseArgs(["--skill", "./skill-a", "--skill", "./skill-b"]);
			expect(result.skills).toEqual(["./skill-a", "./skill-b"]);
		});
	});

	describe("--prompt-template flag", () => {
		test("parses single --prompt-template", () => {
			const result = parseArgs(["--prompt-template", "./prompts"]);
			expect(result.promptTemplates).toEqual(["./prompts"]);
		});

		test("parses multiple --prompt-template flags", () => {
			const result = parseArgs(["--prompt-template", "./one", "--prompt-template", "./two"]);
			expect(result.promptTemplates).toEqual(["./one", "./two"]);
		});
	});

	describe("--theme flag", () => {
		test("parses single --theme", () => {
			const result = parseArgs(["--theme", "./theme.json"]);
			expect(result.themes).toEqual(["./theme.json"]);
		});

		test("parses multiple --theme flags", () => {
			const result = parseArgs(["--theme", "./dark.json", "--theme", "./light.json"]);
			expect(result.themes).toEqual(["./dark.json", "./light.json"]);
		});
	});

	describe("--no-skills flag", () => {
		test("parses --no-skills flag", () => {
			const result = parseArgs(["--no-skills"]);
			expect(result.noSkills).toBe(true);
		});
	});

	describe("--no-prompt-templates flag", () => {
		test("parses --no-prompt-templates flag", () => {
			const result = parseArgs(["--no-prompt-templates"]);
			expect(result.noPromptTemplates).toBe(true);
		});
	});

	describe("--no-themes flag", () => {
		test("parses --no-themes flag", () => {
			const result = parseArgs(["--no-themes"]);
			expect(result.noThemes).toBe(true);
		});
	});

	describe("--no-context-files flag", () => {
		test("parses --no-context-files flag", () => {
			const result = parseArgs(["--no-context-files"]);
			expect(result.noContextFiles).toBe(true);
		});

		test("parses -nc shorthand", () => {
			const result = parseArgs(["-nc"]);
			expect(result.noContextFiles).toBe(true);
		});
	});

	describe("project approval flags", () => {
		test("parses --approve", () => {
			const result = parseArgs(["--approve"]);
			expect(result.projectTrustOverride).toBe(true);
		});

		test("parses -a shorthand", () => {
			const result = parseArgs(["-a"]);
			expect(result.projectTrustOverride).toBe(true);
		});

		test("parses --no-approve", () => {
			const result = parseArgs(["--no-approve"]);
			expect(result.projectTrustOverride).toBe(false);
		});

		test("parses -na shorthand", () => {
			const result = parseArgs(["-na"]);
			expect(result.projectTrustOverride).toBe(false);
		});
	});

	describe("--verbose flag", () => {
		test("parses --verbose flag", () => {
			const result = parseArgs(["--verbose"]);
			expect(result.verbose).toBe(true);
		});
	});

	describe("--offline flag", () => {
		test("parses --offline flag", () => {
			const result = parseArgs(["--offline"]);
			expect(result.offline).toBe(true);
		});
	});

	describe("tool flags", () => {
		test("parses --no-tools flag", () => {
			const result = parseArgs(["--no-tools"]);
			expect(result.noTools).toBe(true);
		});

		test("parses -nt shorthand", () => {
			const result = parseArgs(["-nt"]);
			expect(result.noTools).toBe(true);
		});

		test("parses --no-builtin-tools flag", () => {
			const result = parseArgs(["--no-builtin-tools"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses -nbt shorthand", () => {
			const result = parseArgs(["-nbt"]);
			expect(result.noBuiltinTools).toBe(true);
		});

		test("parses --tools flag", () => {
			const result = parseArgs(["--tools", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses -t shorthand", () => {
			const result = parseArgs(["-t", "read,bash"]);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses --exclude-tools flag", () => {
			const result = parseArgs(["--exclude-tools", "read,bash"]);
			expect(result.excludeTools).toEqual(["read", "bash"]);
		});

		test("parses -xt shorthand", () => {
			const result = parseArgs(["-xt", "read,bash"]);
			expect(result.excludeTools).toEqual(["read", "bash"]);
		});

		test("parses --no-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-tools", "--tools", "read,bash"]);
			expect(result.noTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});

		test("parses --no-builtin-tools with explicit --tools flags", () => {
			const result = parseArgs(["--no-builtin-tools", "--tools", "read,bash"]);
			expect(result.noBuiltinTools).toBe(true);
			expect(result.tools).toEqual(["read", "bash"]);
		});
	});

	describe("messages and file args", () => {
		test("parses plain text messages", () => {
			const result = parseArgs(["hello", "world"]);
			expect(result.messages).toEqual(["hello", "world"]);
		});

		test("parses @file arguments", () => {
			const result = parseArgs(["@README.md", "@src/main.ts"]);
			expect(result.fileArgs).toEqual(["README.md", "src/main.ts"]);
		});

		test("parses mixed messages and file args", () => {
			const result = parseArgs(["@file.txt", "explain this", "@image.png"]);
			expect(result.fileArgs).toEqual(["file.txt", "image.png"]);
			expect(result.messages).toEqual(["explain this"]);
		});

		test("captures unknown long flags with string values", () => {
			const result = parseArgs(["--unknown-flag", "message"]);
			expect(result.messages).toEqual([]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("message");
		});

		test("captures unknown boolean long flags", () => {
			const result = parseArgs(["--unknown-flag"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe(true);
		});

		test("captures unknown long flags with equals syntax", () => {
			const result = parseArgs(["--unknown-flag=value"]);
			expect(result.unknownFlags.get("unknown-flag")).toBe("value");
		});
	});

	describe("complex combinations", () => {
		test("parses multiple flags together", () => {
			const result = parseArgs([
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet",
				"--print",
				"--thinking",
				"high",
				"@prompt.md",
				"Do the task",
			]);
			expect(result.provider).toBe("anthropic");
			expect(result.model).toBe("claude-sonnet");
			expect(result.print).toBe(true);
			expect(result.thinking).toBe("high");
			expect(result.fileArgs).toEqual(["prompt.md"]);
			expect(result.messages).toEqual(["Do the task"]);
		});
	});
});
