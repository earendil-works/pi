import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom } from "./types.ts";

export interface DecayConfig {
	baseDecay: number; // default 0.05 — per-day base decay rate
	archiveThreshold: number; // default 0.1 — strength below this triggers archive
	lastDecayRun: { [atomId: string]: number }; // ms epoch of last decay per atom
}

// Decay formula: new_strength = strength * exp(-lambda * deltaDays / denom)
// lambda = -ln(1 - baseDecay) ≈ baseDecay for small baseDecay
// denom = importance (higher importance decays slower)
function computeNewStrength(
	currentStrength: number,
	importance: number,
	deltaDays: number,
	baseDecay: number,
): number {
	const lambda = -Math.log(1 - baseDecay);
	const denom = Math.max(0.1, importance); // importance acts as decay rate divisor
	const factor = Math.exp((-lambda * deltaDays) / denom);
	return Math.max(0, Math.min(1, currentStrength * factor));
}

// runDecay: decay all active atoms, archive low-strength non-rule atoms
export async function runDecay(
	index: MemoryIndex,
	config: { baseDecay?: number; archiveThreshold?: number } = {},
): Promise<{ archived: string[]; decayed: number; skipped: number }> {
	const baseDecay = config.baseDecay ?? 0.05;
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

		const newStrength = computeNewStrength(atom.strength, atom.importance, deltaDays, baseDecay);
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