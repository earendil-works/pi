// A file of the shapes plugin that imports a package (not a host package): fine for the shapes plugin itself, but a
// plugin importing this file would copy it, and a copied file may not import packages (the ruler plugin shows it).

import { Type } from "typebox";

/** A length in millimetres. */
export const Millimetres = Type.Number({ minimum: 0 });
