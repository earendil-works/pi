// Acme's API, version 2 (`@acme/app/v2`): still provided, as a thin layer over v3. Version 2 called the greetings
// registry `Hellos`; the layer keeps that name, so plugins written against v2 build and run unchanged.

export { constant, defineFacet, Greetings as Hellos, local, str } from "./v3.ts";
