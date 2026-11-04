// Pi Mobile's app-level new-session choices, retained when another conversation opens.
import { createContext, type ReactNode, useContext, useState } from "react";
import type { ModelChoice } from "./ModelPicker.tsx";

type State = {
	location: { env: string | null; cwd: string } | undefined;
	setLocation: (location: { env: string | null; cwd: string }) => void;
	choice: ModelChoice | undefined;
	setChoice: (choice: ModelChoice | undefined) => void;
};
const Context = createContext<State | undefined>(undefined);
export function NewSessionState({ children }: { children: ReactNode }) {
	const [location, setLocation] = useState<State["location"]>();
	const [choice, setChoice] = useState<ModelChoice>();
	return <Context.Provider value={{ location, setLocation, choice, setChoice }}>{children}</Context.Provider>;
}
export function useNewSessionState(): State {
	const state = useContext(Context);
	if (!state) throw new Error("Missing app new-session state");
	return state;
}
