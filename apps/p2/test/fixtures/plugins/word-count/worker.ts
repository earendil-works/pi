// The worker facet: offers the tool to every conversation of the session.
import { contribute, defineFacet } from "@p2/app/v1";
import { Extensions } from "@p2/app/v1/worker";
import { wordCountExtension } from "./tool.ts";

export default defineFacet((host) => {
	contribute(host, "p2.word-count-tool", (self) => {
		self.contribute(Extensions, { [wordCountExtension.name]: wordCountExtension });
	});
});
