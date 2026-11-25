// How large a part a page takes from the server, and so what every hop between them must carry (the Radius brain's
// sockets). Chord's default for untrusted links is 16 MiB on the wire and 64 MiB decoded; a conversation's view is
// the largest part p2 sends (its images are references, src/runtime/entry-images.ts, but long outputs remain).
import type { PartLimits } from "@earendil-works/chord";

const MiB = 1024 * 1024;

/** The limits per part of what a page takes from the server. */
export const SERVER_PART_LIMITS = { part: 32 * MiB, decoded: 128 * MiB } as const satisfies PartLimits;
