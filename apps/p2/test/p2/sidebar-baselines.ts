// The sidebar's browser tests' measure of an item's texts: its name's baseline against its age's. A text's baseline is
// the bottom edge of a zero-size inline-block probe put on its line (vertical-align: baseline puts that edge on the
// baseline). Range rects are not used: Blink rounds a font's ascent and descent, so a glyph box is off the baseline by
// up to half a pixel.

/** One item's texts: its name, its age, its kind, and how far the age's baseline is below the name's (px). */
export type BaselineOffset = {
	readonly label: string;
	readonly end: string;
	readonly kind: "session" | "subagent";
	readonly offset: number;
};

/**
 * A page expression: the `BaselineOffset` of each row of `rows` (a page expression for an array of `.nav-row`s) that
 * shows an age. Kinds: `session` (a session's header row), `subagent`.
 */
export const baselineOffsets = (rows: string): string => `(() => {
	const baseline = (el) => {
		const probe = document.createElement('span');
		probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
		el.append(probe);
		const y = probe.getBoundingClientRect().bottom;
		probe.remove();
		return y;
	};
	return ${rows}.flatMap((e) => {
		const end = e.querySelector('.nav-details .item-age');
		if (!end?.textContent) return [];
		const label = e.querySelector('.session-title');
		const kind = e.classList.contains('session-header') ? 'session' : 'subagent';
		return [{ label: label.textContent, end: end.textContent, kind, offset: baseline(end) - baseline(label) }];
	});
})()`;
