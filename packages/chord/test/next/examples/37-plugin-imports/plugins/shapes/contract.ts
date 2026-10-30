// The shapes plugin's contract (a contracts-only plugin): other plugins import this file and get their own copy of it.
// A copied file may import host packages and files of its own plugin only.

import { local, str } from "@earendil-works/chord/next";

/** A report: its lines. */
export const Report = local("example.report", { version: 1, params: {}, members: { text: str() } });
