// The official JSON-Schema-Test-Suite, drafts 2020-12 and 7: every test, including optional and format tests.
// A test listed in KNOWN_FAILURES must fail; when one starts passing, remove it from the list.

import { describe, expect, it } from "vitest";
import { formats } from "../src/formats/index.ts";
import { compile } from "../src/index.ts";
import { suiteFiles, suiteSchemas } from "./suite.ts";

const KNOWN_FAILURES = new Set([
	// Vocabularies switched off by a custom meta-schema are not supported.
	"draft2020-12/vocabulary > schema that uses custom metaschema with with no validation vocabulary > no validation: invalid number, but it still validates",
	"draft2020-12/optional/format-assertion > schema that uses custom metaschema with format-assertion: false > format-assertion: false: invalid string",
	"draft2020-12/optional/format-assertion > schema that uses custom metaschema with format-assertion: true > format-assertion: true: invalid string",
	// A $ref to a document of another draft is evaluated with the compile's draft.
	"draft2020-12/optional/cross-draft > refs to historic drafts are processed as historic drafts > first item not a string is valid",
	"draft7/optional/cross-draft > refs to future drafts are processed as future drafts > missing bar is invalid",
	// contentMediaType and contentEncoding are annotations.
	"draft7/optional/content > validation of string-encoded content based on media type > an invalid JSON document",
	"draft7/optional/content > validation of binary string-encoding > an invalid base64 string (% is not a valid character)",
	"draft7/optional/content > validation of binary-encoded media type documents > a validly-encoded invalid JSON document",
	"draft7/optional/content > validation of binary-encoded media type documents > an invalid base64 string that is valid JSON",
]);

const schemas = suiteSchemas();

for (const file of suiteFiles()) {
	// Format tests assert formats; everywhere else `format` is an annotation, as draft 2020-12 specifies.
	const options = {
		draft: file.draft,
		schemas,
		formats: file.name.includes("/optional/format/") ? formats : undefined,
	};
	describe(file.name, () => {
		for (const group of file.groups) {
			describe(group.description, () => {
				for (const test of group.tests) {
					const known = KNOWN_FAILURES.has(`${file.name} > ${group.description} > ${test.description}`);
					(known ? it.fails : it)(test.description, () => {
						const validator = compile(group.schema, options);
						expect(validator.check(test.data)).toBe(test.valid);
					});
					it(`${test.description} (errors agree with check)`, () => {
						const validator = compile(group.schema, options);
						const errors = validator.errors(test.data);
						expect(errors.length === 0).toBe(validator.check(test.data));
					});
				}
			});
		}
	});
}
