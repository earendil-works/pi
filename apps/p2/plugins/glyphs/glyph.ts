// Project glyphs: a 3x3 identicon in the Radius mark's four colors, hashed from a project's path. Pure and browser-safe:
// the sidebar draws it inline, `/glyph.svg` (server.ts) serves it as a file. It is the "Tiles, 3x3" generator of the
// project-glyphs prototype with its recommended settings (loose masks, rich shapes, four mirror axes, color regions,
// calm tone), drawing the same glyph for the same seed. Every glyph is mirror-symmetric, so none is a pinwheel (a
// swastika); a 3x3 grid cannot hold a pinwheel anyway.
import { shortPath } from "@p2/app/v1";

/** A glyph: one path per color in a 3x3 view box, cells merged per color (no hairlines between them). */
export type Glyph = { readonly paths: readonly { readonly fill: string; readonly d: string }[] };

/** The glyph of `seed`, a path or a name. Paths count alike in their short form (`/Users/me/x` is `~/x`). */
export function glyphOf(seed: string): Glyph {
	const digest = sha256(`glyph-v1:${normalize(seed)}`);
	// Two streams: the family (colors, mirror axis, corner style) and the structure (cells, shapes).
	const family = random(digest[0]!, digest[1]!, digest[2]!, digest[3]!);
	const structure = random(digest[4]!, digest[5]!, digest[6]!, digest[7]!);
	const order = family.shuffle([0, 1, 2, 3]);
	const orbits = orbitsOf(family.weighted(MIRRORS));
	const scheme = family.weighted(SCHEMES);
	const style = family.weighted(STYLES);
	// The prototype draws a corner radius here, which tiles do not use; drawing it keeps the glyphs the prototype's.
	family.next();
	const flip = family.next() < 0.5;
	const mask = maskOf(orbits, structure);
	const colors = paint(orbits, mask, structure, order, scheme);
	const byColor = new Map<number, string>();
	for (const cell of tiles(orbits, colors, stylesOf(orbits, colors, order, style, flip), structure))
		byColor.set(cell.color, (byColor.get(cell.color) ?? "") + cellPath(cell));
	return { paths: [...byColor].map(([color, d]) => ({ fill: PALETTE[color]!, d })) };
}

/** `glyph` as a standalone SVG document, `size` pixels square. */
export function glyphSvg(glyph: Glyph, size: number): string {
	const paths = glyph.paths.map(({ fill, d }) => `<path fill="${fill}" d="${d}"/>`).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 3 3">${paths}</svg>`;
}

/** Coral, blue, gold, teal: the Radius mark (`RadiusWordMark.tsx` in Radius). */
const PALETTE = ["#f09082", "#4d9abf", "#f1be58", "#83ccd2"];

const N = 3;

function normalize(seed: string): string {
	const path = shortPath(
		seed
			.normalize("NFC")
			.trim()
			.replace(/\\/g, "/")
			.replace(/\/{2,}/g, "/"),
	);
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

const K = Uint32Array.from([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
	0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
	0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
	0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
	0xc67178f2,
]);

/** SHA-256 of `text`'s UTF-8, as eight words. Synchronous, so the sidebar draws glyphs in render. */
function sha256(text: string): Uint32Array {
	const message = new TextEncoder().encode(text);
	const length = ((message.length + 9 + 63) >> 6) << 6;
	const bytes = new Uint8Array(length);
	bytes.set(message);
	bytes[message.length] = 0x80;
	const view = new DataView(bytes.buffer);
	view.setUint32(length - 4, message.length * 8);
	view.setUint32(length - 8, Math.floor((message.length * 8) / 2 ** 32));
	const h = Uint32Array.from([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	const w = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let offset = 0; offset < length; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15]!;
			const b = w[i - 2]!;
			w[i] =
				(w[i - 16]! +
					(rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
					w[i - 7]! +
					(rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) |
				0;
		}
		let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
		for (let i = 0; i < 64; i++) {
			const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) | 0;
		}
		[a, b, c, d, e, f, g, hh].forEach((value, i) => {
			h[i] = h[i]! + value;
		});
	}
	return h;
}

type Random = {
	next(): number;
	int(n: number): number;
	pick<T>(items: readonly T[]): T;
	/** One key of `table` (key and weight pairs, in order), by weight. */
	weighted<T>(table: readonly (readonly [T, number])[]): T;
	shuffle<T>(items: readonly T[]): T[];
};

/** sfc32 seeded with four words, warmed up as the prototype does. */
function random(a: number, b: number, c: number, d: number): Random {
	const next = () => {
		const t = (((a + b) | 0) + d) | 0;
		d = (d + 1) | 0;
		a = b ^ (b >>> 9);
		b = (c + (c << 3)) | 0;
		c = (c << 21) | (c >>> 11);
		c = (c + t) | 0;
		return (t >>> 0) / 4294967296;
	};
	for (let i = 0; i < 12; i++) next();
	const int = (n: number) => Math.floor(next() * n);
	return {
		next,
		int,
		pick: (items) => items[int(items.length)]!,
		weighted: (table) => {
			let x = next() * table.reduce((sum, [, weight]) => sum + weight, 0);
			for (const [key, weight] of table) {
				x -= weight;
				if (x < 0) return key;
			}
			return table.at(-1)![0];
		},
		shuffle: (items) => {
			const out = [...items];
			for (let i = out.length - 1; i > 0; i--) {
				const j = int(i + 1);
				[out[i], out[j]] = [out[j]!, out[i]!];
			}
			return out;
		},
	};
}

/** A cell map of a mirror and how it moves a cell's corners (0 top left, 1 top right, 2 bottom right, 3 bottom left). */
type Mirror = { readonly map: (x: number, y: number) => readonly [number, number]; readonly perm: readonly number[] };

const IDENTITY: Mirror = { map: (x, y) => [x, y], perm: [0, 1, 2, 3] };
const MIRRORS: readonly (readonly [Mirror, number])[] = [
	[{ map: (x, y) => [N - 1 - x, y], perm: [1, 0, 3, 2] }, 34],
	[{ map: (x, y) => [x, N - 1 - y], perm: [3, 2, 1, 0] }, 22],
	[{ map: (x, y) => [y, x], perm: [0, 3, 2, 1] }, 22],
	[{ map: (x, y) => [N - 1 - y, N - 1 - x], perm: [2, 1, 0, 3] }, 22],
];

type Scheme = "mono" | "duo" | "duoA";
/** One color and an accent, two colors, or two and an accent. */
const SCHEMES: readonly (readonly [Scheme, number])[] = [
	["mono", 30],
	["duo", 45],
	["duoA", 25],
];

type Style = "round" | "chamfer" | "percolor";
const STYLES: readonly (readonly [Style, number])[] = [
	["round", 55],
	["chamfer", 15],
	["percolor", 30],
];

/** A cell and its mirror image: they always look alike. `stab`: the corner moves of a mirror that keeps the cell. */
type Orbit = {
	readonly cells: readonly { idx: number; perm: readonly number[] }[];
	readonly stab: readonly (readonly number[])[];
};

function orbitsOf(mirror: Mirror): Orbit[] {
	const seen = new Set<number>();
	const orbits: Orbit[] = [];
	for (let y = 0; y < N; y++)
		for (let x = 0; x < N; x++) {
			if (seen.has(y * N + x)) continue;
			const cells: { idx: number; perm: readonly number[] }[] = [];
			const stab: (readonly number[])[] = [];
			for (const each of [IDENTITY, mirror]) {
				const [a, b] = each.map(x, y);
				const idx = b * N + a;
				if (each !== IDENTITY && idx === y * N + x) stab.push(each.perm);
				if (cells.some((cell) => cell.idx === idx)) continue;
				cells.push({ idx, perm: each.perm });
				seen.add(idx);
			}
			orbits.push({ cells, stab });
		}
	return orbits;
}

const FILL = [Math.ceil(0.4 * N * N), Math.floor(0.8 * N * N)] as const;

/** Filled cells: 4 to 7, touching all four edges (every glyph the same optical size), not pure stripes. */
function maskOf(orbits: readonly Orbit[], rng: Random): Uint8Array {
	let best = new Uint8Array(N * N);
	let bestScore = -Infinity;
	for (let attempt = 0; attempt < 80; attempt++) {
		const mask = new Uint8Array(N * N);
		for (const orbit of orbits) if (rng.next() < 0.5) for (const cell of orbit.cells) mask[cell.idx] = 1;
		const score = maskScore(mask);
		if (score >= 0) return mask;
		if (score > bestScore) {
			bestScore = score;
			best = mask;
		}
	}
	return best;
}

const LINES = [...Array(N).keys()];

function maskScore(mask: Uint8Array): number {
	const at = (x: number, y: number) => mask[y * N + x]!;
	const line = (cell: (a: number, b: number) => number, a: number) => {
		let sum = 0;
		for (let b = 0; b < N; b++) sum += cell(a, b);
		return sum;
	};
	const stripes = (cell: (a: number, b: number) => number) =>
		LINES.every((a) => line(cell, a) === 0 || line(cell, a) === N);
	let penalty = 0;
	if (stripes((y, x) => at(x, y)) || stripes((x, y) => at(x, y))) penalty += 2;
	const filled = mask.reduce((sum, cell) => sum + cell, 0);
	if (filled < FILL[0]) penalty += FILL[0] - filled;
	if (filled > FILL[1]) penalty += filled - FILL[1];
	for (const edge of [0, N - 1]) {
		if (line((y, x) => at(x, y), edge) === 0) penalty += 2;
		if (line((x, y) => at(x, y), edge) === 0) penalty += 2;
	}
	return -penalty;
}

/** Pieces of `mask`; with `colors`, pieces of one color. */
function pieces(mask: ArrayLike<number>, colors?: Int8Array): number {
	const seen = new Set<number>();
	let count = 0;
	for (let start = 0; start < N * N; start++) {
		if (!mask[start] || seen.has(start)) continue;
		const stack = [start];
		seen.add(start);
		while (stack.length) {
			const i = stack.pop()!;
			for (const j of neighbours(i))
				if (mask[j] && !seen.has(j) && (!colors || colors[j] === colors[i])) {
					seen.add(j);
					stack.push(j);
				}
		}
		count++;
	}
	return count;
}

const STEPS: readonly (readonly [number, number])[] = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
];

/** The cells next to cell `i`, in the prototype's order. */
function neighbours(i: number): number[] {
	const x = i % N;
	const y = Math.floor(i / N);
	return STEPS.flatMap(([dx, dy]) => {
		const nx = x + dx;
		const ny = y + dy;
		return nx >= 0 && ny >= 0 && nx < N && ny < N ? [ny * N + nx] : [];
	});
}

const count = (colors: Int8Array, color: number) => colors.reduce((sum, each) => sum + Number(each === color), 0);

/**
 * Colors as regions: one seed orbit per color, each cell the nearest seed's color, keeping the draw with the fewest
 * same-color pieces; the accent takes a smallest orbit at a tip (fewest filled neighbours).
 */
function paint(orbits: readonly Orbit[], mask: Uint8Array, rng: Random, order: readonly number[], scheme: Scheme) {
	const colors = new Int8Array(N * N).fill(-1);
	const filled = orbits.filter((orbit) => mask[orbit.cells[0]!.idx]);
	const k = scheme === "mono" ? 1 : 2;
	const base = order.slice(0, k);
	const MIN_CELLS = 2;
	let best: Int8Array | undefined;
	let fewest = Infinity;
	for (let attempt = 0; attempt < (k > 1 ? 8 : 1); attempt++) {
		const seeds = rng.shuffle(filled).slice(0, k);
		const trial = new Int8Array(N * N).fill(-1);
		for (const orbit of filled)
			for (const { idx } of orbit.cells) {
				let nearest = Infinity;
				let seed = 0;
				seeds.forEach((each, index) => {
					for (const cell of each.cells) {
						const distance =
							((cell.idx % N) - (idx % N)) ** 2 + (Math.floor(cell.idx / N) - Math.floor(idx / N)) ** 2;
						if (distance < nearest - 1e-9) {
							nearest = distance;
							seed = index;
						}
					}
				});
				trial[idx] = base[seed]!;
			}
		if (!base.every((color) => count(trial, color) >= MIN_CELLS)) continue;
		const pieceCount = pieces(
			trial.map((color) => (color >= 0 ? 1 : 0)),
			trial,
		);
		if (pieceCount < fewest) {
			fewest = pieceCount;
			best = trial;
		}
	}
	if (best) colors.set(best);
	else for (const orbit of filled) for (const { idx } of orbit.cells) colors[idx] = base[0]!;
	if (scheme !== "duo") {
		const small = Math.min(...filled.map((orbit) => orbit.cells.length));
		const tip = (orbit: Orbit) => neighbours(orbit.cells[0]!.idx).filter((j) => mask[j]).length;
		const candidates = filled.filter(
			(orbit) =>
				orbit.cells.length === small &&
				count(colors, colors[orbit.cells[0]!.idx]!) - orbit.cells.length >= MIN_CELLS,
		);
		const least = Math.min(...candidates.map(tip));
		const tips = candidates.filter((orbit) => tip(orbit) === least);
		if (tips.length) for (const { idx } of rng.pick(tips).cells) colors[idx] = order[k]!;
	}
	return colors;
}

type CellStyle = "round" | "chamfer";

/** The corner style of each cell: the glyph's, or by color (primary and accent one way, secondary the other). */
function stylesOf(orbits: readonly Orbit[], colors: Int8Array, order: readonly number[], style: Style, flip: boolean) {
	const styles = new Array<CellStyle>(N * N).fill("round");
	for (const orbit of orbits) {
		const rank = order.indexOf(colors[orbit.cells[0]!.idx]!);
		const each: CellStyle = style !== "percolor" ? style : (rank % 2 === 0) !== flip ? "round" : "chamfer";
		for (const { idx } of orbit.cells) styles[idx] = each;
	}
	return styles;
}

type Corner = { readonly kind: "square" | "round" | "cut"; readonly r: number };
type Cell = { readonly x: number; readonly y: number; readonly color: number; readonly corners: readonly Corner[] };

const SQUARE: Corner = { kind: "square", r: 0 };
const corners = (f: (i: number) => Corner) => [0, 1, 2, 3].map(f);
const round = (r: number): Corner => ({ kind: "round", r });

/** The shapes a cell may take, pointing at corner `k`: fan, leaf, drop, dome, wedge, circle, diamond, square. */
const SHAPES: readonly (readonly [(k: number) => Corner[], number])[] = [
	[(k) => corners((i) => (i === k ? round(1) : SQUARE)), 20],
	[(k) => corners((i) => (i === k || i === (k + 2) % 4 ? round(1) : SQUARE)), 14],
	[(k) => corners((i) => (i === k ? SQUARE : round(0.5))), 12],
	[(k) => corners((i) => (i === k || i === (k + 1) % 4 ? round(0.5) : SQUARE)), 12],
	[(k) => corners((i) => (i === k ? { kind: "cut", r: 1 } : SQUARE)), 10],
	[() => corners(() => round(0.5)), 10],
	[() => corners(() => ({ kind: "cut", r: 0.5 })), 8],
	[() => corners(() => SQUARE), 14],
];

/**
 * Each filled orbit draws a shape and where it points (outward half the time), for its first cell; its mirror image
 * gets the mirrored shape. A cell on the axis takes only shapes symmetric across it.
 */
function tiles(orbits: readonly Orbit[], colors: Int8Array, styles: readonly CellStyle[], rng: Random): Cell[] {
	const cells: Cell[] = [];
	const middle = N / 2;
	const cornerAt = [
		[0, 0],
		[1, 0],
		[1, 1],
		[0, 1],
	] as const;
	for (const orbit of orbits) {
		const first = orbit.cells[0]!.idx;
		if (colors[first]! < 0) continue;
		const x = first % N;
		const y = Math.floor(first / N);
		const distances = cornerAt.map(([cx, cy]) => (x + cx - middle) ** 2 + (y + cy - middle) ** 2);
		const outward = distances.indexOf(Math.max(...distances));
		let shape = corners(() => round(0.5));
		for (let attempt = 0; attempt < 16; attempt++) {
			const k = rng.next() < 0.5 ? outward : rng.int(4);
			const candidate = rng.weighted(SHAPES)(k);
			const same = (a: Corner, b: Corner) => a.kind === b.kind && a.r === b.r;
			if (orbit.stab.every((perm) => candidate.every((corner, i) => same(corner, candidate[perm[i]!]!)))) {
				shape = candidate;
				break;
			}
		}
		for (const { idx, perm } of orbit.cells) {
			const mapped = new Array<Corner>(4);
			for (let i = 0; i < 4; i++) mapped[perm[i]!] = shape[i]!;
			// A leaf cut a full cell at two opposite corners would leave nothing: half a cell there.
			const leaf = mapped[0]!.r + mapped[2]!.r > 1 || mapped[1]!.r + mapped[3]!.r > 1;
			cells.push({
				x: idx % N,
				y: Math.floor(idx / N),
				color: colors[idx]!,
				corners:
					styles[idx] === "round"
						? mapped
						: mapped.map((corner) =>
								corner.kind === "square" ? corner : { kind: "cut", r: leaf ? 0.5 : corner.r },
							),
			});
		}
	}
	return cells;
}

const num = (value: number) => +value.toFixed(4);

/** One cell's outline, clockwise from its top edge: arcs for round corners, lines for cut ones. */
function cellPath({ x, y, corners: shape }: Cell): string {
	const r = shape.map((corner) => (corner.kind === "square" ? 0 : corner.r));
	const corner = (i: number, tx: number, ty: number) =>
		r[i] === 0
			? ""
			: shape[i]!.kind === "round"
				? `A${num(r[i]!)} ${num(r[i]!)} 0 0 1 ${num(tx)} ${num(ty)}`
				: `L${num(tx)} ${num(ty)}`;
	return (
		`M${num(x + r[0]!)} ${num(y)}H${num(x + 1 - r[1]!)}${corner(1, x + 1, y + r[1]!)}` +
		`V${num(y + 1 - r[2]!)}${corner(2, x + 1 - r[2]!, y + 1)}` +
		`H${num(x + r[3]!)}${corner(3, x, y + 1 - r[3]!)}` +
		`V${num(y + r[0]!)}${corner(0, x + r[0]!, y)}Z`
	);
}
