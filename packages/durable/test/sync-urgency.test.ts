// `isUrgentCommit`: which Durable commits a host uploads soon (Chord's `FlushScheduler`).
import { describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import { isUrgentCommit } from "../src/index.ts";
import { type CommitPublication, type EntryId, ROOT_CONVERSATION_ID, type Seq } from "../src/types.ts";

const publication = (changes: CommitPublication["changes"]): CommitPublication => ({ seq: 1 as Seq, changes });
const entry = (kind: string) =>
	({
		type: "entry",
		value: { id: idFromNumber<EntryId>(1), conversationId: ROOT_CONVERSATION_ID, kind, data: {} },
	}) as never;

describe("isUrgentCommit", () => {
	it("marks commits with input, answers, or settled submissions as urgent", () => {
		expect(isUrgentCommit(publication([entry("pi.user")]))).toBe(true);
		expect(isUrgentCommit(publication([entry("pi.assistant")]))).toBe(true);
		expect(isUrgentCommit(publication([entry("message")]))).toBe(false);
	});
});
