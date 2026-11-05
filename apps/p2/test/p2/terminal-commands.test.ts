// The terminal tool's tmux commands: argv parsed getopt-style as tmux does, and tmux-like errors.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandError, parseCommand } from "../../plugins/terminals/commands.ts";

test("tmux argv: options first, combined flags, attached or separate values, `--`", () => {
	assert.deepEqual(parseCommand("new-window", ["-n", "dev", "-c", "web", "npm", "run", "dev"]), {
		command: "new-window",
		name: "dev",
		directory: "web",
		shellCommand: "npm run dev",
	});
	assert.deepEqual(parseCommand("new-window", []), { command: "new-window" });
	assert.deepEqual(parseCommand("send-keys", ["-t1", "-l", "npm test", "Enter"]), {
		command: "send-keys",
		target: "1",
		literal: true,
		keys: ["npm test", "Enter"],
	});
	// Options end at the first argument that is not one, or at `--`: `-t` after a key is a key.
	assert.deepEqual(parseCommand("send-keys", ["-t", "dev", "--", "-l", "q"]).command, "send-keys");
	assert.deepEqual(parseCommand("send-keys", ["-t", "dev", "--", "-l"]), {
		command: "send-keys",
		target: "dev",
		literal: false,
		keys: ["-l"],
	});
	assert.deepEqual(parseCommand("send-keys", ["-t", "2", "C-c", "-t"]), {
		command: "send-keys",
		target: "2",
		literal: false,
		keys: ["C-c", "-t"],
	});
	// A value may start with `-`: `-S -50`.
	assert.deepEqual(parseCommand("capture-pane", ["-ep", "-t", "2", "-S", "-50"]), {
		command: "capture-pane",
		target: "2",
		scrollback: 50,
		escapes: true,
	});
	assert.equal((parseCommand("capture-pane", ["-t", "2", "-S", "-"]) as { scrollback: number }).scrollback, 100_000);
	assert.equal((parseCommand("capture-pane", ["-pt2"]) as { scrollback: number }).scrollback, 0);
	assert.deepEqual(parseCommand("kill-window", ["-t", ":3"]), { command: "kill-window", target: ":3" });
	assert.deepEqual(parseCommand("list-windows", []), { command: "list-windows" });
});

test("waits: quiet, exit, none, /regex/ with a timeout in seconds", () => {
	assert.deepEqual(parseCommand("read", ["-t", "1", "-w", "/\\$ $/", "-T", "2.5"]), {
		command: "read",
		target: "1",
		wait: { kind: "match", pattern: "\\$ $", ignoreCase: false },
		timeout: 2.5,
	});
	assert.deepEqual(parseCommand("read", ["-t", "1", "-w", "/ready/i"]), {
		command: "read",
		target: "1",
		wait: { kind: "match", pattern: "ready", ignoreCase: true },
	});
	for (const kind of ["quiet", "exit", "none"])
		assert.deepEqual((parseCommand("send-keys", ["-t", "1", "-w", kind, "q"]) as { wait: unknown }).wait, { kind });
});

test("refusals read like tmux's", () => {
	const refused = (command: Parameters<typeof parseCommand>[0], args: string[], message: string | RegExp) =>
		assert.throws(
			() => parseCommand(command, args),
			(error: unknown) => {
				assert.ok(error instanceof CommandError);
				if (typeof message === "string") assert.equal(error.message, message);
				else assert.match(error.message, message);
				return true;
			},
		);
	refused(
		"send-keys",
		["-x", "-t", "1", "a"],
		"send-keys: unknown option -- x\nusage: send-keys [-l] [-w wait] [-T seconds] -t target-window key ...",
	);
	refused("send-keys", ["-t"], /^send-keys: option requires an argument -- t\nusage: send-keys /);
	refused("send-keys", ["Enter"], "usage: send-keys [-l] [-w wait] [-T seconds] -t target-window key ...");
	refused("send-keys", ["-t", "1"], /^usage: send-keys/);
	refused("read", [], "usage: read [-w wait] [-T seconds] -t target-window");
	refused("read", ["-t", "1", "extra"], /^usage: read/);
	refused("kill-window", [], "usage: kill-window -t target-window");
	refused("list-windows", ["-a"], /^list-windows: unknown option -- a/);
	refused("capture-pane", ["-t", "1", "-S", "ten"], "capture-pane: invalid start line: ten");
	refused("read", ["-t", "1", "-w", "soon"], "read: invalid wait: soon (quiet, exit, none or /regex/)");
	refused("read", ["-t", "1", "-w", "/(/"], /^read: invalid regex: /);
	refused("read", ["-t", "1", "-T", "500"], "read: invalid timeout: 500 (0 to 120 seconds)");
	refused("read", ["-t", "1", "-T", "x"], /^read: invalid timeout: x/);
});
