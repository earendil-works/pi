// The transcript plugin's web facet: it offers apps the transcript view (`TranscriptView`).

import { defineFacet } from "@earendil-works/p3/v1";
import { Views, viewOf } from "@earendil-works/p3/v1/web";
import { TranscriptView } from "./contract.web.ts";
import { TranscriptPane } from "./transcript-pane.tsx";

export default defineFacet((_host, self) => self.contribute(Views, [viewOf(TranscriptView, TranscriptPane)]));
