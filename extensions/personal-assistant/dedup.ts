import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom } from "./types.ts";
import { writeAtomToFile } from "./file-store.ts";

// Cosine dedup gate shared by every write path that already has a fully-shaped
// MemoryAtom + its embedding. Mirrors extraction.ts:executeItem (lines 122-162)
// but accepts the atom + embedding from the caller instead of building them
// from an ExtractionItem, so the webui PATCH path can reuse the 0.65-cosine
// supersede mechanism (design.md Decision 10). Caller does insertAtom /
// updateAtom on the "create" path; this function is the dedup gate, not a
// write primitive.
//
// Self-match guard: when the caller is PATCHing an existing atom, the most
// similar match is the atom itself (cosine 1.0). markSupersededTx would then
// UPDATE that row's is_latest=0 and INSERT a new row with the SAME id, which
// fails on the PRIMARY KEY constraint. In that case we return "create" so the
// caller can do its own in-place updateAtom for the same atom id.
export async function supersedeIfSimilar(
	index: MemoryIndex,
	atomsDir: string,
	newAtom: MemoryAtom,
	embedding: number[] | null,
	threshold?: number,
): Promise<{ status: "supersede" | "create"; atom: MemoryAtom }> {
	if (embedding === null) {
		return { status: "create", atom: newAtom };
	}

	const similar = index.findMostSimilarEmbedding(embedding, threshold ?? 0.65);
	if (!similar) {
		return { status: "create", atom: newAtom };
	}

	if (similar.atom.id === newAtom.id) {
		return { status: "create", atom: newAtom };
	}

	const { newAtom: finalNew } = index.markSupersededTx(similar.atom.id, newAtom, embedding);
	await writeAtomToFile(finalNew, atomsDir);
	return { status: "supersede", atom: finalNew };
}
