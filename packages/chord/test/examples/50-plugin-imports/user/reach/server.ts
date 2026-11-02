// A user's plugin (another root) importing the app's notes contract by its path: refused, a relative path leaving its
// root; a plugin of another repository takes contracts as a dependency (or from the app's API).

import { defineFacet } from "@acme/app/v3";
import { Notes } from "../../plugins/notes/contract.ts";

export default defineFacet(() => console.log(Notes.name));
