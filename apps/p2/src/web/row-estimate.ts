/**
 * Height estimates for list rows never rendered, learned from the rows that were (after react-virtuoso, which sizes
 * unmeasured items from measured ones, and TanStack Virtual's advice to estimate roughly). No element sizes are
 * modeled: the stylesheet decides them, and the measurements carry them here.
 *
 * Rows are grouped by kind (the caller's `features`: a person's message, an answer with tool calls, a tool card), and
 * per kind the height is fitted as a line over text length relative to the list's width (`text / width`, roughly the
 * number of lines times a font's character width): a one-line and a fifty-line answer differ more than any average
 * could cover. Parts whose height the caller knows exactly (images, sized from their headers) are added on top and left
 * out of the fit. A kind with no measurements yet takes the fit over all kinds, and nothing measured at all takes
 * `fallback`.
 *
 * A row's first estimate is kept: later measurements of other rows must not move rows already placed by estimate (a
 * changed estimate below the reader moves what they look at).
 */
export type RowFeatures = {
	/** Rows of one kind share a fit. */
	kind: string;
	/** Text length in characters. */
	text: number;
	/** Height known exactly (images), excluded from the fit. */
	fixed: number;
};

/** A least-squares line through measured (x, y) points, kept as running sums. */
class Fit {
	count = 0;
	#x = 0;
	#y = 0;
	#xx = 0;
	#xy = 0;

	add(x: number, y: number): void {
		this.count++;
		this.#x += x;
		this.#y += y;
		this.#xx += x * x;
		this.#xy += x * y;
	}

	at(x: number): number {
		const n = this.count;
		const mean = this.#y / n;
		const spread = n * this.#xx - this.#x * this.#x;
		// Too few or too alike points for a slope: their mean.
		if (n < 3 || spread <= 1e-9) return mean;
		const slope = (n * this.#xy - this.#x * this.#y) / spread;
		// Longer text is never shorter.
		if (slope < 0) return mean;
		return (this.#y - slope * this.#x) / n + slope * x;
	}
}

export class RowEstimator<Row extends object> {
	readonly #features: (row: Row, width: number) => RowFeatures;
	readonly #fallback: number;
	readonly #kinds = new Map<string, Fit>();
	readonly #all = new Fit();
	readonly #first = new WeakMap<Row, { width: number; height: number }>();

	/** `fallback`: the height of a row while nothing was measured yet. */
	constructor(features: (row: Row, width: number) => RowFeatures, fallback: number) {
		this.#features = features;
		this.#fallback = fallback;
	}

	/** The estimated height of `row` at `width`; the same row at the same width keeps its first estimate. */
	estimate = (row: Row, width: number): number => {
		const kept = this.#first.get(row);
		if (kept?.width === width) return kept.height;
		const { kind, text, fixed } = this.#features(row, width);
		const fit = this.#kinds.get(kind);
		const x = text / Math.max(width, 1);
		const learned = fit?.count ? fit.at(x) : this.#all.count ? this.#all.at(x) : this.#fallback;
		const height = Math.max(0, learned) + fixed;
		this.#first.set(row, { width, height });
		return height;
	};

	/** A rendered row's measured height at `width`. */
	measured = (row: Row, width: number, height: number): void => {
		const { kind, text, fixed } = this.#features(row, width);
		const x = text / Math.max(width, 1);
		const y = Math.max(0, height - fixed);
		let fit = this.#kinds.get(kind);
		if (!fit) {
			fit = new Fit();
			this.#kinds.set(kind, fit);
		}
		fit.add(x, y);
		this.#all.add(x, y);
	};
}
