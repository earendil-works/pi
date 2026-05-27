import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface Statement {
  run(...params: unknown[]): Record<string, unknown> | undefined;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

type DatabaseConstructor = new (path: string) => Database;

let ctor: DatabaseConstructor | undefined;

function isBunRuntime(): boolean {
  return typeof process !== "undefined" && !!process.versions?.bun;
}

function wrapStatement(stmt: unknown): Statement {
  return stmt as Statement;
}

export async function createDatabase(path: string): Promise<Database> {
  if (!ctor) {
    if (isBunRuntime()) {
      const { Database: BunDatabase } = await import("bun:sqlite");
      const origProto = BunDatabase.prototype;
      ctor = class extends (BunDatabase as unknown as new (path: string) => Database) {
        prepare(sql: string): Statement {
          return wrapStatement(origProto.prepare?.call(this, sql));
        }
      } as unknown as new (path: string) => Database;
    } else {
      const { DatabaseSync } = await import("node:sqlite");
      ctor = DatabaseSync as unknown as new (path: string) => Database;
    }
  }
  return new ctor(path);
}
