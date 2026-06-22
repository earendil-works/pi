import { describe, it, expect } from "vitest";

// Smoke test: the two new deps (better-sqlite3 + sqlite-vec) must be
// installed and loadable. This catches:
//   - missing/empty node_modules (extension lives outside npm workspaces,
//     so its deps must be installed explicitly via `npm install`)
//   - native binary rebuild needed for better-sqlite3
//   - sqlite-vec getLoadablePath() returning a path loadExtension() accepts
//
// The extension uses these via the dynamic require pattern from
// AGENTS.md (no inline imports allowed in source files; runtime require
// is fine in tests). Better-sqlite3 is a CommonJS module, so require()
// is the canonical way to load it from any test.
describe("deps loadable", () => {
	it("loads sqlite-vec extension via better-sqlite3", () => {
		const sqliteVec = require("sqlite-vec");
		const Database = require("better-sqlite3");
		const db = new Database(":memory:");
		// getLoadablePath() returns the absolute path to the platform-specific
		// vec0 shared object. loadExtension() loads it into the connection.
		db.loadExtension(sqliteVec.getLoadablePath());
		expect(true).toBe(true);
		db.close();
	});
});