// The chrome plugin's web facet: the page's root (`PageRoot`), the frame with the top bar, the navigator and the
// route's view.

import { defineFacet } from "@earendil-works/p3/v1";
import { PageRoot } from "@earendil-works/p3/v1/web";
import { Frame } from "./frame.tsx";

export default defineFacet((_host, self) => self.contribute(PageRoot, Frame));
