// The gallery plugin's web facet, built for a browser: its stylesheet is collected into one CSS file, its logo is an
// asset imported by URL (content-hashed, under the app's `publicPath`).

import { constant, defineFacet, local, str } from "@earendil-works/chord/next";
import "./gallery.css";
import logo from "./assets/logo.svg?url";

const Gallery = local("example.gallery", { version: 1, params: {}, members: { logo: str() } });

export default defineFacet((host) => host.serve(Gallery, () => ({ logo: constant(logo) })));
