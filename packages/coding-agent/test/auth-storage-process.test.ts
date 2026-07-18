import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const childFixture = fileURLToPath(new URL("./fixtures/shared-auth-refresh-child.ts", import.meta.url));

describe("shared auth-file refresh", () => {
	let cleanup: () => void;
	let authPath: string;

	beforeEach(() => {
		const temp = mkdtempSync(join(tmpdir(), "pi-shared-auth-process-"));
		cleanup = () => rmSync(temp, { recursive: true, force: true });
		authPath = join(temp, "auth.json");
		writeFileSync(
			authPath,
			JSON.stringify({
				"rotating-oauth": {
					type: "oauth",
					access: "expired-access",
					refresh: "refresh-1",
					expires: 0,
				},
			}),
		);
	});

	afterEach(() => cleanup());

	test("performs one rotating refresh across two Node processes using the same literal path", async () => {
		let refreshCount = 0;
		const readyResponses: ServerResponse[] = [];
		const server = createServer(async (request, response) => {
			request.resume();
			if (request.url === "/ready") {
				readyResponses.push(response);
				if (readyResponses.length === 2) {
					for (const ready of readyResponses) ready.end("ready");
				}
				return;
			}
			if (request.url === "/refresh") {
				refreshCount++;
				await new Promise((resolve) => setTimeout(resolve, 50));
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({
						type: "oauth",
						access: "fresh-access",
						refresh: "refresh-2",
						expires: Date.now() + 60_000,
					}),
				);
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Refresh fixture did not bind a TCP port");
			const endpoint = `http://127.0.0.1:${address.port}`;
			const runChild = () =>
				new Promise<string>((resolve, reject) => {
					const child = spawn(process.execPath, ["--import", "tsx", childFixture], {
						cwd: fileURLToPath(new URL("..", import.meta.url)),
						env: {
							...process.env,
							TEST_SHARED_AUTH_PATH: authPath,
							TEST_SHARED_AUTH_ENDPOINT: endpoint,
						},
						stdio: ["ignore", "pipe", "pipe"],
					});
					let stdout = "";
					let stderr = "";
					child.stdout.setEncoding("utf8").on("data", (chunk) => {
						stdout += chunk;
					});
					child.stderr.setEncoding("utf8").on("data", (chunk) => {
						stderr += chunk;
					});
					child.on("error", reject);
					child.on("close", (code) => {
						if (code === 0) resolve(stdout.trim());
						else reject(new Error(`Shared-auth child exited ${code}: ${stderr.trim()}`));
					});
				});

			await expect(Promise.all([runChild(), runChild()])).resolves.toEqual(["ok", "ok"]);
			expect(refreshCount).toBe(1);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}, 15_000);
});
