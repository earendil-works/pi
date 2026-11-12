import { describe, expect, it } from "vitest";
import { initialFormValues, parseQuestionForm, validateForm } from "../src/core/ask/form.ts";

const html = `<form>
<h2>Deployment</h2><p>Choose where the changes will run.</p>
<table><tr><th>Target</th><th>Risk</th></tr><tr><td>Preview</td><td>Isolated</td></tr></table>
<fieldset><legend>Target</legend><label><input type="radio" name="target" value="preview" checked required>Preview</label><label><input type="radio" name="target" value="prod">Production</label></fieldset>
<fieldset><legend>Checks</legend><label><input type="checkbox" name="checks" value="types" checked>Type check</label><label><input type="checkbox" name="checks" value="smoke">Smoke run</label></fieldset>
<label for="count">Instances</label><input id="count" name="count" type="number" min="1" max="9" step="2" value="3">
<label>Notes<textarea name="notes">  preserve whitespace\nsecond line  </textarea></label>
<input name="emptyNumber" type="number"><label><input name="unchecked" type="checkbox">Optional</label>
<select name="regions" multiple><option value="us" selected>US</option><option value="eu" selected>EU</option></select>
<img src="preview.png" alt="Deployment diagram">
</form>`;

describe("semantic question forms", () => {
	it("preserves typed answers, multiline text, groups and omitted optional values", async () => {
		const form = parseQuestionForm(html);
		const values = initialFormValues(form);
		expect(form.fields[0].label).toBe("Target");
		expect(form.fields[3].label).toBe("Notes");
		expect(await validateForm(form, values)).toEqual({
			kind: "valid",
			answers: {
				target: "preview",
				checks: ["types"],
				count: 3,
				notes: "  preserve whitespace\nsecond line  ",
				regions: ["us", "eu"],
			},
		});
		expect(form.blocks).toContainEqual({ kind: "image", source: "preview.png", alt: "Deployment diagram" });
		expect(
			form.blocks
				.filter((block) => block.kind === "markdown")
				.map((block) => block.text)
				.join("\n"),
		).toContain("| Preview | Isolated |");
	});

	it("accepts a custom radio answer and combines a custom multi-answer with checked values", async () => {
		const form = parseQuestionForm(html);
		const values = initialFormValues(form);
		values[0].selected.clear();
		values[0].useOther = true;
		values[0].other = "staging";
		values[1].useOther = true;
		values[1].other = "security review";
		const result = await validateForm(form, values);
		expect(result.kind === "valid" && result.answers.target).toBe("staging");
		expect(result.kind === "valid" && result.answers.checks).toEqual(["types", "security review"]);
	});

	it.each([
		["", "an answer is required"],
		["0", "minimum"],
		["10", "maximum"],
		["2", "steps"],
		["0x3", "finite number"],
		["Infinity", "finite number"],
	])("rejects invalid numeric answer %s", async (text, error) => {
		const form = parseQuestionForm(
			'<form><input name="instances" type="number" required min="1" max="9" step="2"></form>',
		);
		const values = initialFormValues(form);
		values[0].text = text;
		const result = await validateForm(form, values);
		expect(result.kind).toBe("invalid");
		if (result.kind === "invalid") expect(result.message).toContain(error);
	});

	it("rejects missing required choices and blank selected custom answers", async () => {
		const form = parseQuestionForm(html);
		const values = initialFormValues(form);
		values[0].selected.clear();
		expect(await validateForm(form, values)).toMatchObject({ kind: "invalid", field: 0 });
		values[0].useOther = true;
		expect(await validateForm(form, values)).toMatchObject({
			kind: "invalid",
			field: 0,
			message: expect.stringContaining("custom answer"),
		});
	});

	it("validates text patterns without blocking the terminal thread", async () => {
		const form = parseQuestionForm('<form><input name="code" pattern="[A-Z]{2}[0-9]{2}" value="AB12"></form>');
		const values = initialFormValues(form);
		expect(await validateForm(form, values)).toEqual({ kind: "valid", answers: { code: "AB12" } });
		values[0].text = "xAB12x";
		expect(await validateForm(form, values)).toMatchObject({ kind: "invalid", field: 0 });
	});

	it("cancels pathological pattern validation", async () => {
		const form = parseQuestionForm('<form><input name="code" pattern="(a+)+$"></form>');
		const values = initialFormValues(form);
		values[0].text = `${"a".repeat(100)}!`;
		const controller = new AbortController();
		const result = validateForm(form, values, controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow("cancelled");
	});

	it("preserves special object keys as answers without changing the answer prototype", async () => {
		const form = parseQuestionForm(
			'<form><input name="__proto__" value="safe"><input name="constructor" value="value"></form>',
		);
		const result = await validateForm(form, initialFormValues(form));
		expect(result.kind).toBe("valid");
		if (result.kind === "valid") {
			expect(Object.hasOwn(result.answers, "__proto__")).toBe(true);
			expect(JSON.stringify(result.answers)).toBe('{"__proto__":"safe","constructor":"value"}');
			expect(Object.getPrototypeOf(result.answers)).toBe(Object.prototype);
		}
	});

	it.each([
		'<form><input name="x" type="password"></form>',
		'<form><input name="x"><script>alert(1)</script></form>',
		'<form><input name="x"><button>Accept</button></form>',
		'<form><input name="x"><textarea name="x"></textarea></form>',
		"<form><input></form>",
		'<form><input name="x"></form><form><input name="y"></form>',
	])("rejects unsupported or ambiguous form declarations", (source) => {
		expect(() => parseQuestionForm(source)).toThrow();
	});

	it("checks real dates rather than accepting normalized impossible dates", async () => {
		const form = parseQuestionForm('<form><input name="date" type="date" value="2026-02-30"></form>');
		expect(await validateForm(form, initialFormValues(form))).toMatchObject({ kind: "invalid", field: 0 });
	});
});
