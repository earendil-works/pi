/** Shared test-only helpers. */
import { test } from "node:test"; // re-exported so strip-types treats this as a module

export function makeFakeFs(now: number) {
  const files = new Map<string, { content: string; mtime: number }>();
  const fs = {
    mkdirSync: (_p: string) => {},
    writeFileSync: (p: string, content: string) => { files.set(p, { content, mtime: now }); },
    readdirSync: (_p: string) => [...files.keys()],
    statSync: (p: string) => ({ mtimeMs: files.get(p)?.mtime ?? 0 }),
    unlinkSync: (p: string) => { files.delete(p); },
  };
  return { fs, __files: files };
}

export { test };
