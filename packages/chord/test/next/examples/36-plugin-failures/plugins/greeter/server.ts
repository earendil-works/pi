// The greeter plugin's server facet: serves `Greeting` with the text of `label.ts`.

import { constant, defineFacet, local, str } from "@earendil-works/chord/next";
import { greeting } from "./label.ts";

const Greeting = local("example.greeting", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) => host.serve(Greeting, () => ({ text: constant(greeting) })));
