// The environments plugin's messages (the guide's 8.9): every key has a text, and a second catalog renders.

import { describe, it } from "node:test";
import { messages } from "../messages.ts";
import { checkCatalog } from "./catalog.ts";

describe("the environments plugin's messages", () => {
	it("has a text for every key, and a second catalog renders in its place (guide 8.9)", () => {
		checkCatalog(messages);
	});
});
