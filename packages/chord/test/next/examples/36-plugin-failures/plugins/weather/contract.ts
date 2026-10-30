// The weather plugin's contract; the forecast plugin imports (copies) it.

import { int, local } from "@earendil-works/chord/next";

/** Today's temperature. */
export const Weather = local("example.weather", { version: 1, params: {}, members: { celsius: int() } });
