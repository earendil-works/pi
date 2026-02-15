import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import { SessionManager } from "../src/session-manager.js";

describe("extensions: session entry API", () => {
	it("can append custom session entries during extension load", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "mu-ext-session-project-"));
		const extDir = join(projectDir, ".mu", "extensions");
		await mkdir(extDir, { recursive: true });

		const sessionFile = join(projectDir, "session.jsonl");
		const sessionManager = new SessionManager(false, sessionFile, false, projectDir);
		sessionManager.startSession({
			model: { provider: "test", id: "test" },
			thinkingLevel: "off",
			messages: [],
		} as never);

		await writeFile(
			join(extDir, "ext.ts"),
			`
export default function (mu) {
  mu.appendSessionEntry("note", { hello: "world" });
}
`,
			"utf8",
		);

		const mgr = new ExtensionManager({ builtInTools: {}, sessionManager });
		const loader = new ExtensionLoader(mgr, { projectDir, configDir: join(projectDir, "_config") });

		const res = await loader.loadAll();
		expect(res.map((r) => r.ok)).toEqual([true]);

		const raw = await readFile(sessionFile, "utf8");
		expect(raw).toContain('"type":"custom"');
		expect(raw).toContain('"customType":"note"');
		expect(raw).toContain('"hello":"world"');
	});
});
