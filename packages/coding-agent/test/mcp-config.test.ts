import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
	await writeFile(path, value, "utf8");
}

describe("loadMcpConfigFromPaths", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("imports servers from .factory JSON and Codex TOML into the Mu config surface", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-mcp-config-"));
		dirs.push(root);

		const userConfigPath = join(root, ".mu", "agent", "mcp.json");
		const projectDir = join(root, "workspace");
		const factoryConfigPath = join(root, ".factory", "mcp.json");
		const codexConfigPath = join(root, ".codex", "config.toml");

		await writeJson(userConfigPath, { mcpServers: {} });
		await writeJson(factoryConfigPath, {
			mcpServers: {
				figma: {
					type: "http",
					url: "https://mcp.figma.com/mcp",
				},
			},
		});
		await writeText(
			codexConfigPath,
			`[mcp_servers.chrome-devtools]\ncommand = "npx"\nargs = ["-y", "chrome-devtools-mcp@latest"]\n`,
		);

		const { loadMcpConfigFromPaths } = await import("../src/mcp/config.js");
		const config = await loadMcpConfigFromPaths({
			userConfigPath,
			projectDir,
			factoryConfigPath,
			codexConfigPath,
		});

		expect(config.mcpServers.figma).toEqual({
			type: "http",
			url: "https://mcp.figma.com/mcp",
		});
		expect(config.mcpServers["chrome-devtools"]).toEqual({
			command: "npx",
			args: ["-y", "chrome-devtools-mcp@latest"],
		});
	});

	it("lets Mu user and project config override imported definitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-mcp-config-"));
		dirs.push(root);

		const userConfigPath = join(root, ".mu", "agent", "mcp.json");
		const projectDir = join(root, "workspace");
		const projectConfigPath = join(projectDir, ".mu", "mcp.json");
		const factoryConfigPath = join(root, ".factory", "mcp.json");
		const codexConfigPath = join(root, ".codex", "config.toml");

		await writeJson(factoryConfigPath, {
			mcpServers: {
				figma: {
					type: "http",
					url: "https://mcp.figma.com/mcp",
					disabled: true,
				},
			},
		});
		await writeText(codexConfigPath, `[mcp_servers.figma]\nurl = "https://codex.example/mcp"\n`);
		await writeJson(userConfigPath, {
			mcpServers: {
				figma: {
					type: "http",
					url: "https://user.example/mcp",
				},
			},
		});
		await writeJson(projectConfigPath, {
			mcpServers: {
				figma: {
					type: "http",
					url: "https://project.example/mcp",
				},
			},
		});

		const { loadMcpConfigFromPaths } = await import("../src/mcp/config.js");
		const config = await loadMcpConfigFromPaths({
			userConfigPath,
			projectDir,
			factoryConfigPath,
			codexConfigPath,
		});

		expect(config.mcpServers.figma).toEqual({
			type: "http",
			url: "https://project.example/mcp",
		});
	});

	it("does not depend on ~/.codex/config.json for MCP imports", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-mcp-config-"));
		dirs.push(root);

		const userConfigPath = join(root, ".mu", "agent", "mcp.json");
		const projectDir = join(root, "workspace");
		const factoryConfigPath = join(root, ".factory", "mcp.json");
		const codexConfigPath = join(root, ".codex", "config.toml");

		await writeJson(userConfigPath, { mcpServers: {} });
		await writeJson(factoryConfigPath, { mcpServers: {} });
		await writeText(codexConfigPath, `[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\n`);

		const { loadMcpConfigFromPaths } = await import("../src/mcp/config.js");
		const config = await loadMcpConfigFromPaths({
			userConfigPath,
			projectDir,
			factoryConfigPath,
			codexConfigPath,
		});

		expect(config.mcpServers.figma).toEqual({
			url: "https://mcp.figma.com/mcp",
		});
	});

	it("ignores later non-mcp Codex TOML sections instead of merging them into the last MCP server", async () => {
		const root = await mkdtemp(join(tmpdir(), "mu-mcp-config-"));
		dirs.push(root);

		const userConfigPath = join(root, ".mu", "agent", "mcp.json");
		const projectDir = join(root, "workspace");
		const factoryConfigPath = join(root, ".factory", "mcp.json");
		const codexConfigPath = join(root, ".codex", "config.toml");

		await writeJson(userConfigPath, { mcpServers: {} });
		await writeJson(factoryConfigPath, { mcpServers: {} });
		await writeText(
			codexConfigPath,
			[
				`[mcp_servers.figma]`,
				`url = "https://mcp.figma.com/mcp"`,
				``,
				`[[skills.config]]`,
				`path = "/tmp/skill.md"`,
				`enabled = false`,
			].join("\n"),
		);

		const { loadMcpConfigFromPaths } = await import("../src/mcp/config.js");
		const config = await loadMcpConfigFromPaths({
			userConfigPath,
			projectDir,
			factoryConfigPath,
			codexConfigPath,
		});

		expect(config.mcpServers.figma).toEqual({
			url: "https://mcp.figma.com/mcp",
		});
	});
});
