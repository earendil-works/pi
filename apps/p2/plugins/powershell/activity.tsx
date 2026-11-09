// How the `powershell` tool shows in the chat: the generic look, except that a script's call of it shows its command
// line as its input.
import { CommandBlock, parsedArgs, stringOf, type ToolActivity } from "@p2/app/v1/web";

export const powershellActivity: ToolActivity = {
	CallInput: ({ call }) => <CommandBlock command={stringOf(parsedArgs(call.args).command)} />,
};
