// Durable's `fit-images` extension: the images of every tool result the model gets (MCP tools, code mode's `image()`,
// any plugin's tool) fitted to the conversation model's limits before the result is committed, with the worker's image
// processor, as `read` fits the files it reads and the chat plugin fits attachments.
import { createFitImagesExtension } from "@earendil-works/pi-durable/images/fit";
import { contribute, defineFacet } from "@p2/app/v1";
import { Extensions, workerOf } from "@p2/app/v1/worker";

export default defineFacet((host) => {
	contribute(host, "p2.fit-images", (self) => {
		const fit = createFitImagesExtension(workerOf(self)().images);
		self.contribute(Extensions, { [fit.name]: fit });
	});
});
