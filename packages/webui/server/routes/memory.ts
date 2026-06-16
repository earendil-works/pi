import express from "express";
import { unlinkSync } from "node:fs";
import {
	type PersonalAssistantConfig,
	MemoryIndex,
	type MemoryAtom,
	writeAtomToFile,
	readAtomFromFile,
	getAllAtoms,
	rewriteQueryWithCallLlm,
	searchAtomsWithScores,
	ATOMS_DIR,
	MEMORY_DB_PATH,
} from "@earendil-works/pi-personal-assistant";

export interface MemoryDeps {
	dbPath: string;
	atomsDir: string;
	settings: PersonalAssistantConfig;
	callLlm: (prompt: string) => Promise<string>;
}

export function mountMemoryRoutes(app: express.Express, deps: MemoryDeps): void {
	// 6 placeholder routes — subsequent tasks (2.2-2.7) fill in business logic.
	app.get("/api/memory", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.get("/api/memory/:id", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.patch("/api/memory/:id", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.post("/api/memory/:id/archive", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.post("/api/memory/search", (_req, res) => res.status(501).json({ error: "not implemented" }));
	app.get("/api/memory/stats", (_req, res) => res.status(501).json({ error: "not implemented" }));
}