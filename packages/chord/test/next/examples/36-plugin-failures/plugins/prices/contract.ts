// The prices plugin's contract; the summary plugin imports (copies) it. The example moves it to version 2.

import { int, local } from "@earendil-works/chord/next";

/** A price in cents. */
export const Price = local("example.price", { version: 1, params: {}, members: { cents: int() } });
