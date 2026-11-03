// Frames for the terminal (slice 11 §4; fix round 1, Fable L9): the launcher drops a frame over 64 KiB whole (an escape
// it could hide is never written in parts), so the sandbox splits a large write into frames, each cut only between
// escape sequences and never inside a surrogate pair: a first paint of a large true-colour screen arrives whole.

/** The most UTF-16 units of one frame: at most 3 UTF-8 bytes each, so under the launcher's 64 KiB. */
export const FRAME_UNITS = 16 * 1024;

/** `data` as frames of at most `FRAME_UNITS` units, cut outside escape sequences (one longer is its own frame). */
export function splitFrames(data: string): string[] {
	if (data.length <= FRAME_UNITS) return [data];
	const frames: string[] = [];
	let start = 0;
	// The last place a frame may end: after a character or a whole sequence, never inside one.
	let safe = 0;
	let index = 0;
	while (index < data.length) {
		const end = data.charCodeAt(index) === 27 ? sequenceEnd(data, index) : unitEnd(data, index);
		if (end - start > FRAME_UNITS && safe > start) {
			frames.push(data.slice(start, safe));
			start = safe;
		}
		index = end;
		safe = end;
	}
	frames.push(data.slice(start));
	return frames;
}

/** The index after the character at `index`, a surrogate pair kept together. */
function unitEnd(data: string, index: number): number {
	const code = data.charCodeAt(index);
	return code >= 0xd800 && code <= 0xdbff && index + 1 < data.length ? index + 2 : index + 1;
}

/** The index after the escape sequence at `index` (CSI to its final; OSC, DCS and the like to their terminator). */
function sequenceEnd(data: string, index: number): number {
	const introducer = data[index + 1];
	if (introducer === "[") {
		let at = index + 2;
		while (at < data.length && data.charCodeAt(at) >= 0x20 && data.charCodeAt(at) <= 0x3f) at++;
		return Math.min(at + 1, data.length);
	}
	if (introducer !== undefined && "]PX^_".includes(introducer)) {
		for (let at = index + 2; at < data.length; at++) {
			if (data.charCodeAt(at) === 7) return at + 1;
			if (data[at] === "\x1b" && data[at + 1] === "\\") return at + 2;
		}
		return data.length;
	}
	return Math.min(index + 2, data.length);
}
