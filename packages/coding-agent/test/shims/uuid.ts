import { randomUUID } from "node:crypto";

export function v7(): string {
	return randomUUID();
}
