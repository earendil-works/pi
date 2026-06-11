import express from "express";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

export function mountSettingsRoutes(
  app: express.Express,
  deps?: {
    homeDir?: string;
  }
): void {
  const homeDir = deps?.homeDir ?? homedir();

  const settingsPath = join(homeDir, ".pi", "agent", "settings.json");

  /**
   * Deep merge two objects. Arrays are replaced, not merged.
   * The second object overrides the first for primitive values.
   */
  function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { ...target };

    for (const key of Object.keys(source)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        // Both are objects - recurse
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        );
      } else {
        // Override with source value (including arrays, primitives, null)
        result[key] = sourceValue;
      }
    }

    return result;
  }

  /**
   * Read and parse settings file. Returns empty object on any error.
   */
  async function readSettings(): Promise<Record<string, unknown>> {
    try {
      if (!existsSync(settingsPath)) {
        return {};
      }
      const raw = await readFile(settingsPath, "utf-8");
      if (!raw.trim()) {
        return {};
      }
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Write settings to file, creating directories as needed.
   */
  async function writeSettings(settings: Record<string, unknown>): Promise<void> {
    const dir = dirname(settingsPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  }

  // GET /api/settings - return current settings
  app.get("/api/settings", async (_req, res) => {
    const settings = await readSettings();
    res.json(settings);
  });

  // PATCH /api/settings - deep merge partial settings and write back
  app.patch("/api/settings", async (req, res) => {
    const partial = req.body as Record<string, unknown>;

    if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
      res.status(400).json({ error: "Request body must be a non-array object" });
      return;
    }

    const existing = await readSettings();
    const merged = deepMerge(existing, partial);
    await writeSettings(merged);
    res.json(merged);
  });
}
