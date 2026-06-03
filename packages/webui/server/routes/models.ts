import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseModelsJson } from "../lib/parse-models";

export function mountModelsRoutes(app: express.Express): void {
	app.get("/api/models", (_req, res) => {
		const homeDir = app.locals.homeDir ?? homedir();
		const modelsJsonPath = join(homeDir, ".pi", "agent", "models.json");

		let jsonStr: string;
		try {
			if (!existsSync(modelsJsonPath)) {
				res.json({ providers: [] });
				return;
			}
			jsonStr = readFileSync(modelsJsonPath, "utf-8");
		} catch {
			res.json({ providers: [] });
			return;
		}

		const result = parseModelsJson(jsonStr);
		res.json({ providers: result.providers });
	});
}
