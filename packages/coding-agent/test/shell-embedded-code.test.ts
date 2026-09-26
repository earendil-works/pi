import { describe, expect, test } from "vitest";
import { type ShellSegment, splitShellCommand } from "../src/utils/shell-embedded-code.ts";

const EXTENSIONS: Record<string, string> = { rs: "rust", ts: "typescript", py: "python", json: "json" };

function split(command: string): ShellSegment[] {
	const segments = splitShellCommand(command, {
		languageFromPath: (path) => EXTENSIONS[path.slice(path.lastIndexOf(".") + 1)],
	});
	expect(segments.map((segment) => segment.text).join("")).toBe(command);
	return segments;
}

function embedded(command: string): Array<{ text: string; language: string | undefined }> {
	return split(command)
		.filter((segment) => segment.embedded)
		.map((segment) => ({ text: segment.text, language: segment.language }));
}

describe("splitShellCommand", () => {
	test("leaves plain commands as a single shell segment", () => {
		expect(split("cd repo && cargo test 2>&1 | grep -E 'a|b'")).toEqual([
			{ text: "cd repo && cargo test 2>&1 | grep -E 'a|b'", embedded: false },
		]);
	});

	test("splits a python heredoc and keeps following commands as shell", () => {
		const command = "cd repo && python3 - <<'EOF'\ns = open('a').read()\nprint(\"it's\")\nEOF\ncargo test";
		expect(split(command)).toEqual([
			{ text: "cd repo && python3 - <<'EOF'\n", embedded: false },
			{ text: "s = open('a').read()\nprint(\"it's\")\n", embedded: true, language: "python" },
			{ text: "EOF\ncargo test", embedded: false },
		]);
	});

	test("infers interpreters behind wrappers and redirects", () => {
		expect(embedded("uv run --no-project --with httpx --with bs4 python - <<'PY'\nx = 1\nPY")).toEqual([
			{ text: "x = 1\n", language: "python" },
		]);
		expect(embedded("./python.exe - <<'PY' > /tmp/log 2>&1\nx = 1\nPY")).toEqual([
			{ text: "x = 1\n", language: "python" },
		]);
		expect(embedded("node --input-type=module <<'JS'\nconsole.log(1)\nJS")).toEqual([
			{ text: "console.log(1)\n", language: "javascript" },
		]);
		expect(embedded("for d in a b; do timeout 20 bash <<'EOF'\necho $d\nEOF\ndone")).toEqual([
			{ text: "echo $d\n", language: "bash" },
		]);
	});

	test("uses the file extension for cat and tee targets", () => {
		expect(embedded("cat >> deser-json/tests/test_de.rs <<'EOF'\n#[test]\nfn x() {}\nEOF")).toEqual([
			{ text: "#[test]\nfn x() {}\n", language: "rust" },
		]);
		expect(embedded("cat <<'EOF' > out.json\n{}\nEOF")).toEqual([{ text: "{}\n", language: "json" }]);
		expect(embedded("tee -a notes.py <<'EOF'\nx = 1\nEOF")).toEqual([{ text: "x = 1\n", language: "python" }]);
		expect(embedded("F=test/zz-tmp-$$.test.ts && cat > $F <<'EOF'\nconst x = 1;\nEOF")).toEqual([
			{ text: "const x = 1;\n", language: "typescript" },
		]);
	});

	test("falls back to the delimiter name when stdin is data for a script", () => {
		expect(embedded("node tools/workspace.js exec --email a@b.c <<'JS' >out.json &\nreturn 1;\nJS")).toEqual([
			{ text: "return 1;\n", language: "javascript" },
		]);
		expect(embedded("python3 script.py <<'EOF'\ndata\nEOF")).toEqual([{ text: "data\n", language: undefined }]);
		expect(embedded("git commit -F - <<'EOF'\nfix: thing\nEOF")).toEqual([
			{ text: "fix: thing\n", language: undefined },
		]);
	});

	test("handles <<- and consecutive heredocs", () => {
		expect(embedded("python3 - <<-PY\n\tx = 1\n\tPY\nnode <<'JS'\ny()\nJS\n")).toEqual([
			{ text: "\tx = 1\n", language: "python" },
			{ text: "y()\n", language: "javascript" },
		]);
	});

	test("treats an unterminated heredoc as running to the end while streaming", () => {
		expect(split("python3 - <<'EOF'\nprint(1)\nEO")).toEqual([
			{ text: "python3 - <<'EOF'\n", embedded: false },
			{ text: "print(1)\nEO", embedded: true, language: "python" },
		]);
		expect(split("python3 - <<'EO")).toEqual([{ text: "python3 - <<'EO", embedded: false }]);
	});

	test("ignores << inside quotes, arithmetic, and here-strings", () => {
		expect(embedded("rg -n 'a <<EOF b' && echo $((1 << 3)) && cat <<< \"x\"\nfoo")).toEqual([]);
	});

	test("extracts inline interpreter scripts", () => {
		expect(split('cd x && python3 -c "\nimport sys\nprint(sys.argv)\n" 2>&1 | tail')).toEqual([
			{ text: 'cd x && python3 -c "', embedded: false },
			{ text: "\nimport sys\nprint(sys.argv)\n", embedded: true, language: "python" },
			{ text: '" 2>&1 | tail', embedded: false },
		]);
		expect(embedded("node -e 'console.log(1)'")).toEqual([{ text: "console.log(1)", language: "javascript" }]);
		expect(embedded("ruby -rjson -e 'puts 1'")).toEqual([{ text: "puts 1", language: "ruby" }]);
		expect(embedded("perl -0pi -e 's/a/b/' file")).toEqual([{ text: "s/a/b/", language: "perl" }]);
		expect(embedded("zsh -i -c 'echo hi'")).toEqual([{ text: "echo hi", language: "bash" }]);
		expect(embedded("awk -F: '{ print $1 }' /etc/passwd")).toEqual([{ text: "{ print $1 }", language: "awk" }]);
		expect(embedded("osascript -e 'tell app \"Finder\" to quit'")).toEqual([
			{ text: 'tell app "Finder" to quit', language: "applescript" },
		]);
	});

	test("does not treat flags of other tools as inline scripts", () => {
		expect(embedded("grep -e 'foo' x && rg -n 'bar' && git commit -m \"feat: x\n\nbody\"")).toEqual([]);
		expect(embedded("sed -e 's/a/b/' x && python3 script.py -c 'x'")).toEqual([]);
		expect(embedded("python3 -m pytest -c 'conf.ini' && python -mpytest -c 'conf.ini'")).toEqual([]);
		expect(embedded("python3 -m tool <<'EOF'\ndata\nEOF")).toEqual([{ text: "data\n", language: undefined }]);
	});

	test("finds heredocs inside command substitution", () => {
		expect(embedded("git commit -m \"$(cat <<'EOF'\nfix: x\nEOF\n)\"")).toEqual([
			{ text: "fix: x\n", language: undefined },
		]);
	});
});
