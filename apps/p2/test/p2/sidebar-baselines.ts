// The sidebar's browser tests' measure of a row's texts: its label's baseline against its end text's (a time, a step,
// "Failed"). A text's baseline is the bottom edge of a zero-size inline-block probe put on its line (vertical-align:
// baseline puts that edge on the baseline); a word that is a flex item of its own (the failed mark's) is wrapped in a
// span for the measure, then unwrapped. Range rects are not used: Blink rounds a font's ascent and descent, so a glyph
// box is off the baseline by up to half a pixel.

/** One row's texts: its label, its end text, its kind, and how far the end's baseline is below the label's (px). */
export type BaselineOffset = {
	readonly label: string;
	readonly end: string;
	readonly kind: string;
	readonly offset: number;
};

/**
 * A page expression: the `BaselineOffset` of each row `rows` (a page expression for an array of `.nav-row`s) that has an
 * end text. Kinds: `session`, `branch icon`, `branch ring`, `subagent`.
 */
export const baselineOffsets = (rows: string): string => `(() => {
	const textNode = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).at(-1);
	const baseline = (el) => {
		const text = textNode(el);
		const wrap = document.createElement('span');
		text.replaceWith(wrap);
		wrap.append(text);
		const probe = document.createElement('span');
		probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
		wrap.append(probe);
		const y = probe.getBoundingClientRect().bottom;
		wrap.replaceWith(text);
		return y;
	};
	return ${rows}.flatMap((e) => {
		const end = e.querySelector('.nav-details .failed-mark') ?? e.querySelector('.nav-details .subagent-step') ?? e.querySelector('.nav-details .session-time');
		if (!end) return [];
		const label = e.querySelector('.session-title');
		const kind = e.classList.contains('session-header') ? 'session' : e.querySelector(':scope > .branch-row') ? (e.querySelector('.nav-marker .nav-icon') ? 'branch icon' : 'branch ring') : 'subagent';
		return [{ label: label.textContent, end: end.textContent, kind, offset: baseline(end) - baseline(label) }];
	});
})()`;
