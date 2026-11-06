// What plugins use to show their tools' calls in the chat (`@p2/app/v1/web`): the contribution's types, words helpers
// and the parts a call's detail is built from. A plugin contributes its tools' `ToolActivity` to `ToolActivities`.
export {
	CommandBlock,
	DetailImages,
	DetailLink,
	DetailNote,
	DetailProse,
	DetailSection,
	FilePath,
	InputOutput,
	Interrupted,
	NestedCalls,
	OutputBlock,
} from "./Detail.tsx";
export {
	type Described,
	detailsOf,
	failureOf,
	fileName,
	firstLine,
	type Kind,
	type Label,
	lastLine,
	plainText,
	type Step,
	type StepStatus,
	sentence,
	stringOf,
	type ToolActivity,
} from "./model.ts";
