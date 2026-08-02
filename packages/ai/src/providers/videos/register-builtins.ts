import { minimaxVideosApi } from "../../api/minimax-videos.lazy.ts";
import { registerVideosApiProvider } from "../../videos-api-registry.ts";

registerVideosApiProvider(
	{
		api: "minimax-videos",
		...minimaxVideosApi(),
	},
	"minimax-videos",
);
