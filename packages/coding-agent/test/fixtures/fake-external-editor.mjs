import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const capturePath = process.argv[2];
const filePath = process.argv.at(-1);
if (!capturePath || !filePath) {
	process.exit(1);
}

const directory = dirname(filePath);
writeFileSync(
	capturePath,
	JSON.stringify({
		filePath,
		content: readFileSync(filePath, "utf-8"),
		entries: readdirSync(directory),
		directoryMode: statSync(directory).mode & 0o777,
	}),
	"utf-8",
);

if (process.argv.includes("--fail")) {
	process.exit(1);
}
writeFileSync(filePath, process.argv.includes("--empty") ? "" : "edited\n", "utf-8");
