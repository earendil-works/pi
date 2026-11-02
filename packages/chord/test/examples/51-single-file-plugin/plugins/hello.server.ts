// A single-file plugin named `hello` (its file name: `<name>.<kind>.ts`), its server facet: it defines its contract
// inline and serves it. No directory, no package.json: it imports only the app's API.

import { constant, defineFacet, local, str } from "@acme/app/v3";

const Hello = local("example.hello", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) => host.serve(Hello, () => ({ text: constant("hello from one file") })));
