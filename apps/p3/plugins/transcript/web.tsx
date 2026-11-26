// The transcript plugin's web facet: it offers apps the transcript component (`TranscriptView`).

import { defineFacet } from "@earendil-works/p3/v1";
import { Components, componentOf } from "@earendil-works/p3/v1/web";
import { TranscriptView } from "./contract.web.ts";
import { TranscriptPane } from "./transcript-pane.tsx";

export default defineFacet((_host, self) => self.contribute(Components, [componentOf(TranscriptView, TranscriptPane)]));
