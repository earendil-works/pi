// The report plugin's server facet: one of each import a facet may have.

import { readFileSync } from "node:fs";
import { constant, defineFacet } from "@earendil-works/chord/next";
import { pluginFile } from "@earendil-works/chord/next/plugins";
// Host packages: an ES module (default and named imports) and a CommonJS one, the app's own instances.
import app, { currency } from "@example/app";
import legacy from "@example/legacy";
// An npm dependency: inlined into this script by the build (installed first).
import { greet } from "example-greeting";
// A `chord.external` package: left external, loaded from this plugin's node_modules when the script runs.
import { where } from "example-native";
// A contract of another plugin: a copy built into this script.
import { Report } from "../shapes/contract.ts";

// A file of this plugin, read at run time by its absolute path.
const rates = JSON.parse(readFileSync(pluginFile("data/rates.json"), "utf8")) as { readonly vat: number };

export default defineFacet((host) =>
	host.serve(Report, () => ({
		text: constant(
			[
				`${app.name} v${app.version}`,
				currency(1250),
				legacy.pad("vat", 6),
				`${rates.vat}%`,
				greet("plugins"),
				where().split("/").slice(-3).join("/"),
			].join(" | "),
		),
	})),
);
