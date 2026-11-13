// The notes plugin's shared contract: data only, importable from every kind. Other plugins of this root import it by
// relative path; the build copies it into their scripts.

import { local, str } from "@acme/app/v3";

/** The notes, as one text. */
export const Notes = local("acme.notes", { version: 1, params: {}, members: { text: str() } });
