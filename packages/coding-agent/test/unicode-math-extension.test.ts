import { describe, expect, test } from "vitest";
import { renderUnicodeMath, texToUnicode } from "../examples/extensions/unicode-math.ts";

describe("unicode math extension", () => {
	test("converts common TeX notation", () => {
		expect(texToUnicode("E = mc^2")).toBe("E = mc²");
		expect(texToUnicode("\\frac{\\alpha + 1}{\\sqrt{x_2}} \\leq \\mathbb{R}")).toBe("(α + 1)⁄(√(x₂)) ≤ ℝ");
		expect(texToUnicode("x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}")).toBe("x = (-b ± √(b² - 4ac))⁄(2a)");
		expect(texToUnicode("\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}")).toBe("∑[k=1…n] k = (n(n+1))⁄(2)");
	});

	test("uses the available Unicode superscript and subscript alphabets", () => {
		expect(texToUnicode("x^{abcdefghijklmnopqrstuvwxyz}")).toBe("xᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖ𐞥ʳˢᵗᵘᵛʷˣʸᶻ");
		expect(texToUnicode("x^{ABCDEFGHIJKLMNOPQRSTUVW}")).toBe("xᴬᴮꟲᴰᴱꟳᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾꟴᴿ꟱ᵀᵁⱽᵂ");
		expect(texToUnicode("x^{\\alpha\\beta}_\\gamma")).toBe("xᵅᵝᵧ");
		expect(texToUnicode("x^{XYZ}")).toBe("x^XYZ");
	});

	test("renders inline and display formulas", () => {
		const rendered = renderUnicodeMath("Inline $x_1^2 + \\pi$ and display:\n\n$$\\sum_{i=1}^n i$$");

		expect(rendered).toContain("Inline x₁² + π");
		expect(rendered).toContain("∑\\[i=1…n\\] i");
		expect(rendered).not.toContain("$$");
	});

	test("renders bracket-delimited inline and display formulas", () => {
		const rendered = renderUnicodeMath("Inline \\(x_1^2 + \\pi\\) and display:\n\n\\[\\sum_{i=1}^n i\\]");

		expect(rendered).toContain("Inline x₁² + π");
		expect(rendered).toContain("∑\\[i=1…n\\] i");
		expect(rendered).not.toContain("\\(");
		expect(rendered).not.toContain("\\sum");
	});

	test("renders large-operator bounds as linear ranges", () => {
		expect(texToUnicode("\\sum_{i=1}^n i")).toBe("∑[i=1…n] i");
		expect(texToUnicode("\\int_0^\\infty e^{-x}\\,dx")).toBe("∫[0…∞] e⁻ˣ dx");
		expect(texToUnicode("\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}")).toBe("∫[-∞…∞] e⁻ˣ² dx = √(π)");
		expect(texToUnicode("\\prod^n_{k=1} k")).toBe("∏[k=1…n] k");
		expect(texToUnicode("\\sum_i a_i")).toBe("∑[i] aᵢ");
		expect(texToUnicode("\\int^b f(x) dx")).toBe("∫[…b] f(x) dx");
	});

	test("renders aligned, matrix, and cases environments", () => {
		expect(
			texToUnicode(String.raw`\begin{aligned}
(a+b)^2 &= a^2 + 2ab + b^2 \\
(a-b)^2 &= a^2 - 2ab + b^2
\end{aligned}`),
		).toBe("(a+b)² = a² + 2ab + b²\n(a-b)² = a² - 2ab + b²");

		expect(
			texToUnicode(String.raw`A =
\begin{pmatrix}
1 & 2 \\
3 & 4
\end{pmatrix}`),
		).toBe("A = ⎛1 2⎞\n    ⎝3 4⎠");

		expect(
			texToUnicode(String.raw`f(x) =
\begin{cases}
x^2, & x \ge 0 \\
-x, & x < 0
\end{cases}`),
		).toBe("f(x) = ⎧ x², x ≥ 0\n       ⎩ -x, x < 0");
	});

	test("leaves formulas in code spans and fenced code blocks unchanged", () => {
		const markdown = "`$x^2$` and $y^2$\n\n```tex\n$x^2$\n```\n\nBut $z^2$ changes.";
		const rendered = renderUnicodeMath(markdown);

		expect(rendered).toContain("`$x^2$` and y²");
		expect(rendered).toContain("```tex\n$x^2$\n```");
		expect(rendered).toContain("But z² changes.");
	});

	test("preserves link destinations and raw HTML", () => {
		const markdown = [
			"[formula $x^2$](https://example.com/$x$)",
			"<https://example.com/$y$>",
			"https://example.com/$q$",
			'<span title="$z$">body $w$</span>',
			"<div>$v$</div>",
		].join("\n\n");
		const rendered = renderUnicodeMath(markdown);

		expect(rendered).toContain("[formula x²](https://example.com/$x$)");
		expect(rendered).toContain("<https://example.com/$y$>");
		expect(rendered).toContain("https://example.com/$q$");
		expect(rendered).toContain('<span title="$z$">body w</span>');
		expect(rendered).toContain("<div>$v$</div>");
	});

	test("uses CommonMark backtick-run semantics", () => {
		const markdown = "``before```x` $y^2$ ``";
		expect(renderUnicodeMath(markdown)).toBe(markdown);
	});

	test("preserves currency, escaped delimiters, and unsupported TeX", () => {
		expect(renderUnicodeMath("Cost is $5$ today")).toBe("Cost is $5$ today");
		expect(renderUnicodeMath("Literal \\\\(x^2\\\\)")).toBe("Literal \\\\(x^2\\\\)");
		expect(texToUnicode("\\unknown{x}")).toBe("\\unknown{x}");
	});
});
