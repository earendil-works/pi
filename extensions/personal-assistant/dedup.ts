import type { MemoryIndex } from "./storage.ts";
import type { MemoryAtom } from "./types.ts";
import { writeAtomToFile } from "./file-store.ts";

// Cosine dedup gate shared by every write path that already has a fully-shaped
// MemoryAtom + its embedding. Mirrors extraction.ts:executeItem (lines 122-162)
// but accepts the atom + embedding from the caller instead of building them
// from an ExtractionItem, so the webui PATCH path can reuse the 0.92-cosine
// supersede mechanism (design.md Decision 2). Caller does insertAtom /
// updateAtom on the "create" path; this function is the dedup gate, not a
// write primitive.
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

	const similar = index.findMostSimilarEmbedding(embedding, threshold ?? 0.92);
	if (!similar) {
		return { status: "create", atom: newAtom };
	}

	const { newAtom: finalNew } = index.markSupersededTx(similar.atom.id, newAtom, embedding);
	await writeAtomToFile(finalNew, atomsDir);
	return { status: "supersede", atom: finalNew };
}
