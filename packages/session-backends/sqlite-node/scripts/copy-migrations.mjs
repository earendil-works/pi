import { cp, mkdir } from "node:fs/promises";

const source = new URL("../src/sqlite/migrations/", import.meta.url);
const target = new URL("../dist/sqlite/migrations/", import.meta.url);

await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
