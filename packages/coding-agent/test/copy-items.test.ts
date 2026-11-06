import { describe, expect, it } from "vitest";
import { getCopyItems } from "../src/modes/interactive/copy-items.ts";

describe("copy item extraction", () => {
	it("groups code blocks and quotes before the unchanged whole response", () => {
		const text =
			"> First quote\n> continued\n\n```ts\n  const value = 1;\n```\n\n> Second quote\n\n```bash\nnpm run check\n```";
		expect(getCopyItems(text)).toEqual([
			{ kind: "code", label: "Code 1 · ts", text: "  const value = 1;" },
			{ kind: "code", label: "Code 2 · bash", text: "npm run check" },
			{ kind: "quote", label: "Quote 1", text: "First quote\ncontinued" },
			{ kind: "quote", label: "Quote 2", text: "Second quote" },
			{ kind: "whole", label: "Whole response", text },
		]);
	});

	it("does not extract quote markers or nested fences from inside a code block", () => {
		const text = "````md\n> literal quote\n```js\nconst x = 1;\n```\n````";
		expect(getCopyItems(text)).toEqual([
			{ kind: "code", label: "Code 1 · md", text: "> literal quote\n```js\nconst x = 1;\n```" },
			{ kind: "whole", label: "Whole response", text },
		]);
	});

	it("finds code blocks inside lists and quotes, preserving indentation and inner Markdown", () => {
		const text =
			"- Example:\n\n  ```js\n  function run() {\n    return 1;\n  }\n  ```\n\n> **Note**\n>\n> ```sh\n> echo done\n> ```";
		expect(getCopyItems(text)).toEqual([
			{ kind: "code", label: "Code 1 · js", text: "function run() {\n  return 1;\n}" },
			{ kind: "code", label: "Code 2 · sh", text: "echo done" },
			{ kind: "quote", label: "Quote 1", text: "**Note**\n\n```sh\necho done\n```" },
			{ kind: "whole", label: "Whole response", text },
		]);
	});

	it("offers the content of an unfinished fenced block while a response is streaming", () => {
		const text = "```python\ndef run():\n    return 1";
		expect(getCopyItems(text)).toEqual([
			{ kind: "code", label: "Code 1 · python", text: "def run():\n    return 1" },
			{ kind: "whole", label: "Whole response", text },
		]);
	});

	it("offers only the original response when there are no blocks", () => {
		const text = "Keep `inline code` inline.\r\n\r\nOriginal spacing.  \r\n";
		expect(getCopyItems(text)).toEqual([{ kind: "whole", label: "Whole response", text }]);
	});
});
