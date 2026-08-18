#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_REPO = "earendil-works/pi";
const DEFAULT_BASE_PATH = "packages/coding-agent";
const DEFAULT_CHANGELOG = "packages/coding-agent/CHANGELOG.md";
const DEFAULT_FIX_SINCE_TAG = "v0.74.0";
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

function printUsage() {
	console.log(`Usage: node scripts/release-notes.mjs <command> [options]

Commands:
  extract              Extract release notes from the coding-agent changelog
  fix-github-releases  Rewrite existing GitHub release note links in place

extract options:
  --version <x.y.z>    Version to extract
  --tag <vX.Y.Z>       Release tag used for repository links (defaults to v<version>)
  --changelog <path>   Changelog path (default: ${DEFAULT_CHANGELOG})
  --out <path>         Output file (default: stdout)
  --repo <owner/repo>  GitHub repository for generated links (default: ${DEFAULT_REPO})
  --base-path <path>   Base path for relative changelog links (default: ${DEFAULT_BASE_PATH})

fix-github-releases options:
  --repo <owner/repo>     GitHub repository to patch (default: ${DEFAULT_REPO})
  --tag <vX.Y.Z>          Patch only one release tag
  --since-tag <vX.Y.Z>    Oldest release tag to patch (default: ${DEFAULT_FIX_SINCE_TAG})
  --base-path <path>      Base path for relative changelog links (default: ${DEFAULT_BASE_PATH})
  --dry-run               Print releases that would change without updating GitHub
`);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result.stdout ?? "";
}

function parseOptions(args) {
	const options = {
		basePath: DEFAULT_BASE_PATH,
		changelog: DEFAULT_CHANGELOG,
		dryRun: false,
		out: undefined,
		repo: DEFAULT_REPO,
		sinceTag: DEFAULT_FIX_SINCE_TAG,
		tag: undefined,
		version: undefined,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}

		const optionNames = new Set(["--base-path", "--changelog", "--out", "--repo", "--since-tag", "--tag", "--version"]);
		if (!optionNames.has(arg)) {
			throw new Error(`Unknown option: ${arg}`);
		}

		const value = args[++i];
		if (!value) {
			throw new Error(`${arg} requires a value`);
		}

		if (arg === "--base-path") options.basePath = value;
		if (arg === "--changelog") options.changelog = value;
		if (arg === "--out") options.out = value;
		if (arg === "--repo") options.repo = value;
		if (arg === "--since-tag") options.sinceTag = value;
		if (arg === "--tag") options.tag = value;
		if (arg === "--version") options.version = value;
	}

	return options;
}

function normalizeTag(tagOrVersion) {
	if (!tagOrVersion) {
		return undefined;
	}
	return tagOrVersion.startsWith("v") ? tagOrVersion : `v${tagOrVersion}`;
}

function versionFromTag(tag) {
	return tag.startsWith("v") ? tag.slice(1) : tag;
}

function compareVersions(a, b) {
	const aParts = versionFromTag(a).split(".").map(Number);
	const bParts = versionFromTag(b).split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelogSection(changelog, version) {
	const headingRe = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");
	const heading = headingRe.exec(changelog);

	if (!heading) {
		return "";
	}

	const sectionStart = heading.index + heading[0].length;
	const rest = changelog.slice(sectionStart);
	const nextHeading = rest.search(/^## \[/m);
	const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
	return section.trim();
}

function splitLocalTarget(target) {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

function normalizePathPart(value) {
	return value.replaceAll("\\", "/");
}

function normalizeBasePath(basePath) {
	const normalized = path.posix.normalize(normalizePathPart(basePath)).replace(/\/+$/, "");
	return normalized === "." ? "" : normalized;
}

function resolveRepositoryPath(targetPath, basePath) {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(normalizeBasePath(basePath), normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

function isDirectoryTarget(originalPath, repositoryPath) {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

function normalizeLinkTarget(target, options) {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${options.repo}`);
	const repoUrl = `https://github.com/${options.repo}`;

	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${options.tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart, options.basePath);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${options.repo}/${route}/${options.tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

function normalizeReleaseNoteLinks(markdown, options) {
	const changes = [];
	const normalized = markdown.replace(INLINE_MARKDOWN_LINK_RE, (match, prefix, target, suffix) => {
		const normalizedTarget = normalizeLinkTarget(target, options);
		if (normalizedTarget !== target) {
			changes.push({ from: target, to: normalizedTarget });
		}
		return `${prefix}${normalizedTarget}${suffix}`;
	});

	return { changes, markdown: normalized };
}

function writeOutput(content, outPath) {
	if (outPath) {
		writeFileSync(outPath, content);
		return;
	}

	process.stdout.write(content);
}

function extractReleaseNotes(options) {
	const version = options.version ?? (options.tag ? versionFromTag(options.tag) : undefined);
	if (!version) {
		throw new Error("extract requires --version or --tag");
	}

	if (!existsSync(options.changelog)) {
		throw new Error(`Changelog does not exist: ${options.changelog}`);
	}

	const tag = normalizeTag(options.tag ?? version);
	const changelog = readFileSync(options.changelog, "utf8");
	const section = extractChangelogSection(changelog, version);
	const rawNotes = section ? `${section}\n` : `Release ${version}\n`;
	const { markdown } = normalizeReleaseNoteLinks(rawNotes, { basePath: options.basePath, repo: options.repo, tag });
	writeOutput(markdown, options.out);
}

function listGithubReleases(repo) {
	const output = run("gh", ["api", `repos/${repo}/releases`, "--paginate", "--jq", ".[] | {id, tag_name, body} | @json"], {
		capture: true,
	});
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function uniqueChanges(changes) {
	const seen = new Set();
	const unique = [];
	for (const change of changes) {
		const key = `${change.from}\n${change.to}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		unique.push(change);
	}
	return unique;
}

function updateGithubRelease(repo, tag, body) {
	const tempDir = mkdtempSync(path.join(tmpdir(), "pi-release-notes-"));
	try {
		const notesPath = path.join(tempDir, "notes.md");
		writeFileSync(notesPath, body);
		run("gh", ["release", "edit", tag, "--repo", repo, "--notes-file", notesPath], { capture: true });
	} finally {
		rmSync(tempDir, { force: true, recursive: true });
	}
}

function fixGithubReleases(options) {
	const tagFilter = normalizeTag(options.tag);
	const sinceTag = normalizeTag(options.sinceTag);
	const matchingReleases = listGithubReleases(options.repo).filter((release) => !tagFilter || release.tag_name === tagFilter);

	if (tagFilter && matchingReleases.length === 0) {
		throw new Error(`Release not found: ${tagFilter}`);
	}

	const releases = matchingReleases.filter((release) => compareVersions(release.tag_name, sinceTag) >= 0);
	if (tagFilter && releases.length === 0) {
		console.log(`Skipping ${tagFilter}: older than ${sinceTag}.`);
		console.log(`${options.dryRun ? "Would update" : "Updated"} 0 releases.`);
		return;
	}

	let changedCount = 0;
	for (const release of releases) {
		const tag = release.tag_name;
		const body = release.body ?? "";
		const result = normalizeReleaseNoteLinks(body, { basePath: options.basePath, repo: options.repo, tag });
		if (result.markdown === body) {
			continue;
		}

		changedCount++;
		const unique = uniqueChanges(result.changes);
		console.log(`${options.dryRun ? "Would update" : "Updating"} ${tag} (${unique.length} link${unique.length === 1 ? "" : "s"})`);
		for (const change of unique) {
			console.log(`  ${change.from}`);
			console.log(`  -> ${change.to}`);
		}

		if (!options.dryRun) {
			updateGithubRelease(options.repo, tag, result.markdown);
		}
	}

	const prefix = options.dryRun ? "Would update" : "Updated";
	console.log(`${prefix} ${changedCount} release${changedCount === 1 ? "" : "s"}.`);
}

try {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "--help") {
		printUsage();
		process.exit(command ? 0 : 1);
	}

	const options = parseOptions(args);
	if (command === "extract") {
		extractReleaseNotes(options);
	} else if (command === "fix-github-releases") {
		fixGithubReleases(options);
	} else {
		throw new Error(`Unknown command: ${command}`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
