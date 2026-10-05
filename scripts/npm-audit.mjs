// Runs `npm audit --omit=dev` and fails on advisories at or above the audit
// level, except for advisories that were reviewed and accepted below. Every
// accepted advisory must name the affected package and explain why it does not
// apply. Remove an entry once a fixed version is installed; the script warns
// about entries that no longer match.

import { spawnSync } from "node:child_process";

const auditLevel = "moderate";
const severities = ["info", "low", "moderate", "high", "critical"];

/** @type {Record<string, { package: string; reason: string }>} */
const acceptedAdvisories = {
	"GHSA-86w9-cpqp-85rv": {
		package: "node-forge",
		reason:
			"No fixed node-forge release exists. It is only reachable through @earendil-works/gondolin in the private, " +
			"unpublished gondolin example extension. Gondolin only verifies leaf certificates against its own locally " +
			"generated CA (public exponent 65537), so the low-exponent signature forgery does not apply.",
	},
};

const result = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) {
	throw result.error;
}

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr);
	process.stderr.write(result.stdout);
	console.error("npm audit did not produce a JSON report.");
	process.exit(1);
}

if (report.error) {
	console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
	process.exit(1);
}

const minimumSeverity = severities.indexOf(auditLevel);
const seenAccepted = new Set();
const failures = new Map();

for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
	for (const via of vulnerability.via) {
		// String entries point at another vulnerable package, which is reported on its own.
		if (typeof via === "string") {
			continue;
		}
		const id = via.url?.split("/").pop() ?? String(via.source);
		const accepted = acceptedAdvisories[id];
		if (accepted && accepted.package === via.name) {
			seenAccepted.add(id);
			continue;
		}
		if (severities.indexOf(via.severity) >= minimumSeverity) {
			failures.set(`${id}:${via.name}`, via);
		}
	}
}

for (const id of seenAccepted) {
	console.log(`Accepted ${id} (${acceptedAdvisories[id].package}): ${acceptedAdvisories[id].reason}`);
}

for (const id of Object.keys(acceptedAdvisories)) {
	if (!seenAccepted.has(id)) {
		console.log(`::warning::Accepted advisory ${id} no longer matches; remove it from scripts/npm-audit.mjs.`);
	}
}

if (failures.size > 0) {
	console.error(`\nFound ${failures.size} unaccepted advisories at or above ${auditLevel}:`);
	for (const via of failures.values()) {
		console.error(`- ${via.name} ${via.range} [${via.severity}] ${via.title} ${via.url}`);
	}
	process.exit(1);
}

console.log(`No unaccepted advisories at or above ${auditLevel}.`);
