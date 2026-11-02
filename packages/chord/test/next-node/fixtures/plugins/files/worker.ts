// Fixture plugin (slice 7c): a facet reading a file of its own plugin through `pluginFile`.

import { readFileSync } from "node:fs";
import { constant, defineFacet } from "@earendil-works/chord/next";
import { pluginFile } from "@earendil-works/chord/next/plugins";
import { Files } from "../contracts/contract.ts";

export default defineFacet((host) =>
	host.serve(Files, () => ({ text: constant(readFileSync(pluginFile("assets/data.txt"), "utf8").trim()) })),
);
