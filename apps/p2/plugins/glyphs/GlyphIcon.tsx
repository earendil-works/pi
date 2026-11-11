// A project glyph inline (glyph.ts), for markers in lists: decorative, the row it sits in names the place.
import { useMemo } from "react";
import { glyphOf } from "./glyph.ts";

/** The glyph of `seed` (a path or a name), `size` pixels square. */
export function GlyphIcon({ seed, size = 16 }: { seed: string; size?: number }) {
	const glyph = useMemo(() => glyphOf(seed), [seed]);
	return (
		<svg className="glyph-icon" width={size} height={size} viewBox="0 0 3 3" aria-hidden="true" focusable="false">
			{glyph.paths.map(({ fill, d }) => (
				<path key={fill} fill={fill} d={d} />
			))}
		</svg>
	);
}
