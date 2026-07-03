import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom } from "./types.ts";

export interface DecayConfig {
	/** Half-life in days at importance=1. After this many days without
	 *  access, a reference-strength atom retains 50% of its strength.
	 *  Effective half-life scales with importance: at importance=2 the
	 *  effective half-life is 2× this value, at importance=0.5 it is 0.5×.
	 *  Default 33 days. */
	halfLifeDays: number;
	/** Strength below this threshold is archived (soft-deleted from
	 *  the active index + vector store). rule-typed atoms never archive.
	 *  Default 0.1. */
	archiveThreshold: number;
	/** ms epoch of last decay per atom. */
	lastDecayRun: { [atomId: string]: number };
}

// Decay formula: new_strength = strength * exp(-lambda * deltaDays / denom)
//   lambda = ln(2) / halfLifeDays
//   denom  = max(0.1, importance)
// At importance=1: after halfLifeDays without access, strength = 0.5 * original.
// At importance=k: effective half-life is k * halfLifeDays.
function computeNewStrength(
	currentStrength: number,
	importance: number,
	deltaDays: number,
	halfLifeDays: number,
): number {
	const lambda = Math.LN2 / halfLifeDays;
	const denom = Math.max(0.1, importance);
	const factor = Math.exp((-lambda * deltaDays) / denom);
	return Math.max(0, Math.min(1, currentStrength * factor));
}

// runDecay: decay all active atoms, archive low-strength non-rule atoms.
// Trigger: called from session_start hook, throttled per-process to
// at most once per DECAY_INTERVAL_MS (24h). Each per-atom call applies
// the elapsed-time factor in one shot — strength is stamped fresh and
// last_access is set to now so the next run starts from this checkpoint
// (without this, a long-lived atom would compound the factor across runs
// and decay exponentially faster than the formula says).
export async function runDecay(
	index: MemoryIndex,
	config: { halfLifeDays?: number; archiveThreshold?: number } = {},
): Promise<{ archived: string[]; decayed: number; skipped: number }> {
	const halfLifeDays = config.halfLifeDays ?? 33;
	const archiveThreshold = config.archiveThreshold ?? 0.1;
	const now = Date.now();
	const atoms = index.getActiveAtoms();

	const archived: string[] = [];
	let decayed = 0;
	let skipped = 0;

	for (const atom of atoms) {
		const lastAccess = atom.last_access ?? atom.created_at;
		const deltaMs = now - lastAccess;
		const deltaDays = deltaMs / (1000 * 60 * 60 * 24);

		if (deltaDays < 1 / 24) {
			// Less than 1 hour since last access — skip
			skipped++;
			continue;
		}

		const newStrength = computeNewStrength(atom.strength, atom.importance, deltaDays, halfLifeDays);
		index.updateStrength(atom.id, newStrength);
		// Stamp last_access = now so the NEXT decay run measures delta
		// from this checkpoint, not from created_at. Without this, every
		// decay run multiplies the same factor and strength compounds
		// exponentially: factor^N after N runs (regression test in
		// test/decay.test.ts "does not compound ...").
		index.updateLastAccess(atom.id);
		decayed++;

		// Rule type NEVER archives (per design)
		if (atom.type === "rule") continue;

		// Archive if strength below threshold
		if (newStrength < archiveThreshold) {
			index.markArchived(atom.id);
			index.deleteVector(atom.id);
			archived.push(atom.id);
		}
	}

	return { archived, decayed, skipped };
}
