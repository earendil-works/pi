// Project glyphs (plugins/glyphs/glyph.ts): the prototype's glyphs for the same seeds, seeds that name one place drawing
// one glyph, the Radius colors only, mirror symmetry, and how far apart the glyphs of similar seeds are.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { glyphOf, glyphSvg } from "../../plugins/glyphs/glyph.ts";

const PALETTE = new Set(["#f09082", "#4d9abf", "#f1be58", "#83ccd2"]);

describe("glyphOf", () => {
	it("draws the prototype's glyph for a seed", () => {
		// From the project-glyphs prototype (Tiles, 3x3, recommended settings), which glyph.ts ports.
		assert.deepEqual(glyphOf("~/Development/pi-mono"), {
			paths: [
				{
					fill: "#f1be58",
					d: "M1 0H1V0A1 1 0 0 1 0 1H0V1A1 1 0 0 1 1 0ZM1 0H2V0A1 1 0 0 1 1 1H1V0ZM0 1H1V1A1 1 0 0 1 0 2H0V1Z",
				},
				{
					fill: "#4d9abf",
					d: "M2.5 0H2.5L3 0.5V0.5L2.5 1H2.5L2 0.5V0.5L2.5 0ZM0.5 2H0.5L1 2.5V2.5L0.5 3H0.5L0 2.5V2.5L0.5 2Z",
				},
			],
		});
		assert.deepEqual(glyphOf("radius"), {
			paths: [
				{ fill: "#4d9abf", d: "M1.5 0H1.5A0.5 0.5 0 0 1 2 0.5V1H1V0.5A0.5 0.5 0 0 1 1.5 0ZM1 2H2V3H1V2Z" },
				{ fill: "#83ccd2", d: "M0 2H1V3H0V2ZM2 2H3V3H2V2Z" },
			],
		});
	});

	it("draws one glyph for the ways one place is written", () => {
		const glyph = glyphOf("~/Development/pi-mono");
		for (const seed of [
			"/Users/someone/Development/pi-mono",
			"/home/someone/Development/pi-mono/",
			"/data/data/com.termux/files/home/Development/pi-mono",
			" ~/Development//pi-mono ",
			"~\\Development\\pi-mono",
		])
			assert.deepEqual(glyphOf(seed), glyph, seed);
		assert.notDeepEqual(glyphOf("~/Development/pi-mono-2"), glyph);
	});

	it("uses the Radius colors, at most three, inside the 3x3 box", () => {
		for (let i = 0; i < 300; i++) {
			const { paths } = glyphOf(`~/Development/project-${i}`);
			assert.ok(paths.length >= 1 && paths.length <= 3);
			for (const { fill, d } of paths) {
				assert.ok(PALETTE.has(fill), fill);
				for (const number of d.match(/-?\d+(\.\d+)?/g) ?? []) assert.ok(Number(number) >= 0 && Number(number) <= 3);
			}
		}
	});

	it("is mirror-symmetric: a pinwheel (a swastika) cannot come out", () => {
		for (let i = 0; i < 300; i++) {
			const picture = raster(glyphOf(`~/Development/project-${i}`));
			const mirrors = [
				(x: number, y: number) => picture[y]![R - 1 - x],
				(x: number, y: number) => picture[R - 1 - y]![x],
				(x: number, y: number) => picture[x]![y],
				(x: number, y: number) => picture[R - 1 - x]![R - 1 - y],
			];
			// Sample points on an edge are in or out by rounding, not by symmetry. With R = 49 (coprime with 6) no point
			// lies on a circle or a straight edge, except on the grid's two diagonals (a 45-degree cut along one): at most
			// 2R points may differ. A shape pointing the wrong way differs in about half a cell (about 130 points).
			const mismatches = (mirror: (x: number, y: number) => string | null | undefined) =>
				picture.reduce((sum, line, y) => sum + line.filter((color, x) => color !== mirror(x, y)).length, 0);
			assert.ok(Math.min(...mirrors.map(mismatches)) <= 2 * R, `project-${i}`);
		}
	});

	it("tells similar seeds apart", () => {
		const glyphs = new Set<string>();
		for (let i = 0; i < 200; i++) glyphs.add(JSON.stringify(glyphOf(`~/Development/pi-mono-${i}`)));
		assert.equal(glyphs.size, 200);
	});
});

describe("glyphSvg", () => {
	it("is a standalone SVG document of the requested size", () => {
		const svg = glyphSvg(glyphOf("radius"), 48);
		assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="48" height="48" viewBox="0 0 3 3">/);
		assert.equal(svg.match(/<path /g)?.length, 2);
	});
});

const R = 49;

/**
 * The glyph's colors at the centres of an R x R grid (null: empty), by its paths: each path is cells, one `M…Z` each,
 * whose outline is straight lines and 90-degree arcs; a point is inside when the polygon through the outline's points,
 * arcs sampled, contains it.
 */
function raster(glyph: ReturnType<typeof glyphOf>): (string | null)[][] {
	const shapes = glyph.paths.flatMap(({ fill, d }) =>
		d
			.split("Z")
			.filter(Boolean)
			.map((cell) => ({ fill, polygon: outline(cell) })),
	);
	return Array.from({ length: R }, (_, py) =>
		Array.from({ length: R }, (_, px) => {
			const x = ((px + 0.5) / R) * 3;
			const y = ((py + 0.5) / R) * 3;
			return shapes.find((shape) => contains(shape.polygon, x, y))?.fill ?? null;
		}),
	);
}

/** The points of one cell's outline (M, H, V, L, A commands), arcs as 8 segments each. */
function outline(cell: string): [number, number][] {
	const points: [number, number][] = [];
	let at: [number, number] = [0, 0];
	for (const [, command, args] of cell.matchAll(/([MHVLA])([^MHVLA]*)/g)) {
		const n = (args ?? "")
			.trim()
			.split(/[\s,]+/)
			.filter(Boolean)
			.map(Number);
		if (command === "M" || command === "L") at = [n[0]!, n[1]!];
		else if (command === "H") at = [n[0]!, at[1]];
		else if (command === "V") at = [at[0], n[0]!];
		else {
			// A clockwise (sweep 1) quarter arc of radius r from `at` to the end: its centre is to the right of the chord.
			const [r, end] = [n[0]!, [n[5]!, n[6]!] as [number, number]];
			const [mx, my] = [(at[0] + end[0]) / 2, (at[1] + end[1]) / 2];
			const [dx, dy] = [end[0] - at[0], end[1] - at[1]];
			const half = Math.hypot(dx, dy) / 2;
			const toCentre = Math.sqrt(Math.max(0, r * r - half * half)) / (2 * half);
			const centre: [number, number] = [mx - dy * toCentre, my + dx * toCentre];
			const from = Math.atan2(at[1] - centre[1], at[0] - centre[0]);
			let to = Math.atan2(end[1] - centre[1], end[0] - centre[0]);
			if (to < from) to += 2 * Math.PI;
			for (let i = 1; i <= 8; i++) {
				const angle = from + ((to - from) * i) / 8;
				points.push([centre[0] + r * Math.cos(angle), centre[1] + r * Math.sin(angle)]);
			}
			at = end;
			continue;
		}
		points.push(at);
	}
	return points;
}

function contains(polygon: [number, number][], x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i]!;
		const [xj, yj] = polygon[j]!;
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
