/**
 * Not a test — a guard against the cliffs found during implementation. Reports
 * units you can reason about: cost per WRITE, and bytes on the wire relative to
 * bytes consumed.
 *
 *   npx vitest bench delta.bench.ts
 *
 * The headline finding: cost is per write, not per byte. A 100-byte chunk costs
 * about the same as a 1 KB chunk, because the fixed cost is the window slice and
 * the overlap probe. So chunk size — set by the exec env's coalescing interval,
 * not by this package — decides both throughput and wire size.
 */
import { bench, describe } from "vitest";
import { decoder, encoder, track } from "./delta-impl.ts";

const WORDS = "the quick brown fox jumps over lazy dog while considering strategies".split(" ");
const text = (n: number): string => {
	let s = "";
	while (s.length < n) s += `${WORDS[Math.floor(Math.random() * WORDS.length)]} `;
	return s.slice(0, n);
};

const CAP = 50_000;
const WRITES = 500;
const FLUSH_EVERY = 20;

/** One write = one chunk handed to the sink. Returns nothing; bench times it. */
function drive(initial: string, chunkSize: number, cap = CAP): void {
	const t = track({ out: initial });
	for (let i = 0; i < WRITES; i++) {
		const next = t.state.out + text(chunkSize);
		t.state.out = next.length > cap ? next.slice(next.length - cap) : next;
		if (i % FLUSH_EVERY === FLUSH_EVERY - 1) t.flush();
	}
	t.flush();
}

/**
 * Measured on the reference machine, 500 writes each. Reproduced here so a
 * regression is legible rather than just "slower".
 *
 *   append only, 100 B      127 µs/write    8k writes/s   101% of input on wire
 *   rolling,     100 B      176 µs/write    6k writes/s   135% of input on wire
 *   rolling,     1 KB        68 µs/write   15k writes/s   104% of input on wire
 *   rolling,     8 KB       366 µs/write    3k writes/s    31% of input on wire
 *   pathological, 100 B     307 µs/write    3k writes/s   727% of input on wire
 *
 * Two things to notice.
 *
 * 135% at 100-byte chunks: past the cap every write emits `truncate` + `append`,
 * and two op envelopes exceed a 100-byte payload — we put MORE on the wire than we
 * consumed. At 8 KB it is 31%. Flush granularity is therefore a size lever, not
 * just an update-rate lever, and the exec env's coalescing is what keeps chunks
 * off the bad end of that curve.
 *
 * The pathological row is bounded only because the overlap candidate scan is
 * capped. Unbounded it was 4.7 s for 2000 writes against 93 ms; the cap makes it
 * give up and emit a set — larger, never wrong.
 */
describe("rolling window, 50 KB cap", () => {
	bench("100 B chunks", () => { drive(text(CAP), 100); });
	bench("1 KB chunks", () => { drive(text(CAP), 1024); });
	bench("8 KB chunks", () => { drive(text(CAP), 8192); });
	bench("pathological: one repeated character", () => { drive("x".repeat(CAP), 100); });
});

describe("below the cap", () => {
	// The dominant case for most tools: startsWith fast path, no probe at all,
	// and one append per flush rather than a truncate/append pair.
	bench("append only, never fills", () => { drive("", 100, Number.MAX_SAFE_INTEGER); });
});

// ── Codec: what path interning and arity omission actually save ────────────
//
// Reported as wire bytes relative to inline paths, on three shapes:
//   - one hot path (a rolling tool-output window): omission does the work
//   - a few alternating paths (lane state): interning does the work
//   - many distinct paths: neither helps, and definitions cost a little
describe("codec", () => {
	const streams = {
		"one hot path": () => {
			const t = track({ content: [{ type: "text", text: "" }] });
			return Array.from({ length: 200 }, (_, i) => {
				(t.state.content[0] as { text: string }).text += `line ${i} of build output\n`;
				return t.flush();
			});
		},
		"four alternating paths": () => {
			const t = track({ a: "", b: "", c: "", d: "" });
			return Array.from({ length: 200 }, (_, i) => {
				for (const k of ["a", "b", "c", "d"] as const) t.state[k] += `${i}`;
				return t.flush();
			});
		},
		"200 distinct paths": () => {
			const root: Record<string, number> = {};
			for (let i = 0; i < 200; i++) root[`f${i}`] = 0;
			const t = track(root);
			return Array.from({ length: 5 }, (_, r) => {
				for (let i = 0; i < 200; i++) t.state[`f${i}`] = r + 1;
				return t.flush();
			});
		},
	};

	for (const [label, build] of Object.entries(streams)) {
		bench(label, () => {
			const enc = encoder();
			const dec = decoder();
			for (const ops of build()) dec.decode(enc.encode(ops));
		});
	}
});
