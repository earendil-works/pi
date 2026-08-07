#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
const versionPattern = /^(\d+)\.(\d+)\.(\d+)-mupt\.(\d+)$/;
const packagePaths = ["packages/ai/package.json", "packages/agent/package.json", "packages/coding-agent/package.json"];

if (!target || (target !== "patch" && target !== "minor" && !versionPattern.test(target))) {
	console.error("Usage: node scripts/version-mupt-packages.mjs <patch|minor|x.y.z-mupt.n>");
	process.exit(1);
}

const packages = packagePaths.map((path) => ({ path, data: JSON.parse(readFileSync(path, "utf8")) }));
const versions = new Set(packages.map(({ data }) => data.version));
if (versions.size !== 1) throw new Error("Mupt package versions are not aligned");
const current = packages[0].data.version;
const match = versionPattern.exec(current);
if (!match) throw new Error(`Unsupported current Mupt version: ${current}`);

let version = target;
if (target === "patch") version = `${match[1]}.${match[2]}.${match[3]}-mupt.${Number(match[4]) + 1}`;
if (target === "minor") version = `${match[1]}.${Number(match[2]) + 1}.0-mupt.1`;

const names = ["@mupt-ai/pi-ai", "@mupt-ai/pi-agent-core", "@mupt-ai/pi-coding-agent"];
for (let index = 0; index < packages.length; index++) {
	const pkg = packages[index].data;
	pkg.name = names[index];
	pkg.version = version;
	pkg.repository = { ...pkg.repository, type: "git", url: "git+https://github.com/mupt-ai/steppable-pi.git" };
}
packages[1].data.dependencies["@mupt-ai/pi-ai"] = version;
packages[2].data.dependencies["@mupt-ai/pi-ai"] = version;
packages[2].data.dependencies["@mupt-ai/pi-agent-core"] = version;
for (const { path, data } of packages) writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
console.log(`Updated Mupt packages to ${version}`);
