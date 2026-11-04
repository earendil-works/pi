// Builds p2's web UI for hosts other than p2 itself, and uploads it to R2: the Radius Cloud Brain page, and p2 brains
// whose page loads it from there. The UI is p2's own (`plugins/*/web.tsx`, `src/web/`, `src/hosts/web/`): this builds
// it with `buildWebBundle` and patches the three places where the built script assumes p2 serves it:
//
// - the Chord socket: the page bootstrap's `chordUrl` (`data-pi-bootstrap`), else `/chord` on the page's host;
// - the version poll: this build's manifest.json instead of `/__p2_web`;
// - asset URLs (the terminal's wasm): this build's directory instead of `/__p2_web/`.
//
// A patch whose target is missing stops the build: `src/hosts/web/main.tsx` or `WEB_BUNDLE_PATH` changed, and this
// script must follow. Source maps are dropped (they embed the sources; the bundle is served publicly).
//
// Each build lives under the full commit SHA it was built from, in two variants with a manifest each:
//   <sha>/        cloud: the plugins Radius Cloud Brain serves
//   <sha>/brain/  brain: every p2 plugin with a web facet
// The SHA is the same one pkg.earendil.com publishes pi's packages under, so a consumer pins one SHA for the packages
// (and the p2 contracts they bind) and for this UI. Files are immutable once uploaded: an existing build is kept.
//
//   node --import ./src/source.ts scripts/cloud-bundle.ts build --sha <sha> --base <path or URL> [--out dir]
//   node --import ./src/source.ts scripts/cloud-bundle.ts upload --sha <sha> --bucket <name> --endpoint <url>
//       [--prefix <key prefix>] [--out dir]
//
// `--base` is where the page loads `<sha>/` from: a root-relative path (`/pi/ui/<sha>`), so one build works on every
// host that serves the bucket under that path (production and staging alike), or an absolute URL. It is built into the
// script: the version poll fetches `<base>/manifest.json`, assets load from `<base>/`. `upload` uses the AWS CLI against
// R2's S3 API, with credentials from the environment (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).

import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildWebBundle } from "../src/hosts/bundles.ts";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** The plugins Radius Cloud Brain serves. `web-shell` registers the "app" slot; without it the page stays on "Loading…". */
const CLOUD = ["web-shell", "artifacts", "chat", "drafts", "models", "sessions", "status", "subagents", "workspace"];
/** Every p2 plugin with a web facet: a p2 brain's full UI. */
const BRAIN = [
	"artifacts",
	"chat",
	"chat-mode",
	"conversations",
	"devices",
	"drafts",
	"envs",
	"login",
	"logs",
	"models",
	"ports",
	"prompt",
	"sessions",
	"sharing",
	"status",
	"subagents",
	"terminals",
	"voice",
	"web-shell",
	"workspace",
];

const VARIANTS = [
	{ name: "cloud", plugins: CLOUD, directory: "" },
	{ name: "brain", plugins: BRAIN, directory: "brain" },
] as const;

const TYPES: Readonly<Record<string, string>> = {
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".wasm": "application/wasm",
};
/** Content-named files and a build's manifest never change once uploaded. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/** The page bootstrap's `chordUrl`, else `/chord` on the page's host (as p2 serves it). */
const CHORD_URL =
	// biome-ignore lint/suspicious/noTemplateCurlyInString: source text spliced into the built script, not a template.
	'(()=>{const fallback=`${location.protocol==="https:"?"wss":"ws"}://${location.host}/chord`;' +
	'try{const raw=document.getElementById("root")?.getAttribute("data-pi-bootstrap");' +
	"return (raw?JSON.parse(raw):undefined)?.chordUrl??fallback}catch{return fallback}})()";

class UsageError extends Error {}

function patch(source: string, from: string, to: string, all = false): string {
	if (!source.includes(from)) throw new Error(`patch target not found: ${from}`);
	return all ? source.split(from).join(to) : source.replace(from, to);
}

function assertSha(sha: string | undefined): string {
	if (sha === undefined || !FULL_SHA.test(sha)) throw new UsageError(`--sha must be a full commit SHA, got ${sha}`);
	return sha;
}

/** Builds both variants into `<out>/<sha>/`. */
async function build(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			sha: { type: "string" },
			base: { type: "string" },
			out: { type: "string", default: "cloud-bundle" },
		},
	});
	const sha = assertSha(values.sha);
	const baseUrl = values.base?.replace(/\/$/, "");
	if (!baseUrl) throw new UsageError("build needs --base");
	const root = join(resolve(values.out), sha);
	await rm(root, { recursive: true, force: true });
	for (const { name, plugins, directory } of VARIANTS) {
		const output = join(root, directory);
		const url = directory ? `${baseUrl}/${directory}` : baseUrl;
		const manifestUrl = `${url}/manifest.json`;
		// Plugins without a web facet are skipped by the build.
		const bundle = await buildWebBundle(plugins);
		await mkdir(output, { recursive: true });
		let script: string | undefined;
		let style: string | undefined;
		for (const [file, content] of bundle.files) {
			if (file.endsWith(".map")) continue;
			let body: Uint8Array | string = content.body;
			if (file === bundle.script) {
				let text = new TextDecoder().decode(content.body);
				text = patch(
					text,
					// biome-ignore lint/suspicious/noTemplateCurlyInString: the built script's exact text, not a template.
					'new WebSocket(`${location.protocol==="https:"?"wss":"ws"}://${location.host}/chord`)',
					`new WebSocket(${CHORD_URL})`,
				);
				text = patch(
					text,
					'fetch("/__p2_web",{cache:"no-store",credentials:"same-origin"})',
					`fetch(${JSON.stringify(manifestUrl)},{cache:"no-store"})`,
				);
				if (text.includes("/__p2_web/")) text = patch(text, "/__p2_web/", `${url}/`, true);
				text = text.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/, "\n");
				if (text.includes("__p2_web")) throw new Error(`${name}: the script still names /__p2_web`);
				body = text;
				script = file;
			} else if (file === bundle.style) {
				body = new TextDecoder().decode(content.body).replace(/\n?\/\*# sourceMappingURL=[^*]*\*\/\s*$/, "\n");
				style = file;
			}
			await writeFile(join(output, file), body);
		}
		if (!script) throw new Error(`${name}: bundle has no script`);
		// `version` is what the page compares with `data-web-version` (Radius sets it from this manifest).
		const manifest = {
			version: `pi-${sha}${directory ? `-${directory}` : ""}`,
			script,
			stylesheets: style ? [style] : [],
			commit: sha,
			plugins,
		};
		await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		console.log(JSON.stringify({ variant: name, output, manifest: manifestUrl, script, style }));
	}
}

/** Uploads `<out>/<sha>/` to `s3://<bucket>/<prefix><sha>/`, unless that build exists already (builds are immutable). */
async function upload(argv: string[]): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			sha: { type: "string" },
			bucket: { type: "string" },
			endpoint: { type: "string" },
			prefix: { type: "string", default: "" },
			out: { type: "string", default: "cloud-bundle" },
		},
	});
	const sha = assertSha(values.sha);
	if (!values.bucket || !values.endpoint) throw new UsageError("upload needs --bucket and --endpoint");
	const prefix = values.prefix.replace(/^\/+/, "");
	const root = join(resolve(values.out), sha);
	const key = (file: string) => `${prefix}${sha}/${relative(root, file).split("\\").join("/")}`;
	const manifestKey = `${prefix}${sha}/manifest.json`;
	if (
		aws(
			["s3api", "head-object", "--bucket", values.bucket, "--key", manifestKey, "--endpoint-url", values.endpoint],
			true,
		)
	) {
		console.log(`exists s3://${values.bucket}/${manifestKey}: kept`);
		return;
	}
	const files = await listFiles(root);
	// The manifests last: a manifest that is visible names files that are already there.
	const ordered = [
		...files.filter((file) => !file.endsWith("manifest.json")),
		...files.filter((file) => file.endsWith("manifest.json")),
	];
	for (const file of ordered) {
		const type = TYPES[extname(file)] ?? "application/octet-stream";
		aws([
			"s3",
			"cp",
			file,
			`s3://${values.bucket}/${key(file)}`,
			"--endpoint-url",
			values.endpoint,
			"--content-type",
			type,
			"--cache-control",
			IMMUTABLE,
			"--only-show-errors",
		]);
		console.log(`uploaded s3://${values.bucket}/${key(file)}`);
	}
}

async function listFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path)));
		else files.push(path);
	}
	return files.sort();
}

/** Runs the AWS CLI; with `allowNotFound`, a missing object is `false` instead of an error. */
function aws(args: string[], allowNotFound = false): boolean {
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		env: {
			...process.env,
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			AWS_EC2_METADATA_DISABLED: "true",
		},
	});
	if (result.error) throw result.error;
	if (result.status === 0) return true;
	const message = `${result.stdout}\n${result.stderr}`.trim();
	if (allowNotFound && /(?:404|NoSuchKey|Not Found)/i.test(message)) return false;
	throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n${message}`);
}

const USAGE = `Usage:
  node --import ./src/source.ts scripts/cloud-bundle.ts build --sha <sha> --base <path or URL> [--out dir]
  node --import ./src/source.ts scripts/cloud-bundle.ts upload --sha <sha> --bucket <name> --endpoint <url> [--prefix <key prefix>] [--out dir]`;

const [command, ...rest] = process.argv.slice(2);
try {
	if (command === "build") await build(rest);
	else if (command === "upload") await upload(rest);
	else throw new UsageError(USAGE);
} catch (error) {
	console.error(error instanceof UsageError ? error.message : `cloud-bundle: ${(error as Error).message}`);
	process.exit(1);
}
