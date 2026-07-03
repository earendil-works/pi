import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommandsPage from "./CommandsPage";
import { api } from "../lib/api";

vi.mock("../lib/api", () => ({
	api: {
		getQuickCommands: vi.fn(),
		setQuickCommands: vi.fn(),
	},
}));

const mockedApi = api as unknown as {
	getQuickCommands: ReturnType<typeof vi.fn>;
	setQuickCommands: ReturnType<typeof vi.fn>;
};

function renderPage() {
	return render(
		<MemoryRouter>
			<CommandsPage />
		</MemoryRouter>,
	);
}

describe("CommandsPage", () => {
	beforeEach(() => {
		mockedApi.getQuickCommands.mockReset();
		mockedApi.setQuickCommands.mockReset();
		mockedApi.setQuickCommands.mockResolvedValue(undefined);
	});

	it("shows loading then empty state when no commands", async () => {
		mockedApi.getQuickCommands.mockResolvedValueOnce([]);
		renderPage();
		await waitFor(() => {
			expect(screen.queryByText(/No quick commands configured yet/)).toBeTruthy();
		});
	});

	it("renders existing commands on load", async () => {
		mockedApi.getQuickCommands.mockResolvedValueOnce([
			{ name: "review", description: "Code review", prompt: "Review: $ARG" },
			{ name: "commit", prompt: "Make a commit" },
		]);
		renderPage();
		await waitFor(() => {
			expect(screen.getByText("/review")).toBeTruthy();
			expect(screen.getByText("/commit")).toBeTruthy();
		});
	});

	it("Save changes button is disabled until a change is made", async () => {
		mockedApi.getQuickCommands.mockResolvedValueOnce([
			{ name: "review", prompt: "x" },
		]);
		renderPage();
		await waitFor(() => screen.getByText("/review"));
		const saveBtn = screen.getByText("Save changes") as HTMLButtonElement;
		expect(saveBtn.disabled).toBe(true);
	});

	it("editing a row enables Save; Save calls api.setQuickCommands", async () => {
		mockedApi.getQuickCommands.mockResolvedValueOnce([
			{ name: "review", prompt: "old prompt" },
		]);
		renderPage();
		await waitFor(() => screen.getByText("/review"));
		fireEvent.click(screen.getByText("Edit"));
		const promptArea = screen.getByLabelText("Command prompt") as HTMLTextAreaElement;
		fireEvent.change(promptArea, { target: { value: "new prompt" } });
		fireEvent.click(screen.getByText("Save"));
		const saveBtn = screen.getByText("Save changes") as HTMLButtonElement;
		expect(saveBtn.disabled).toBe(false);
		fireEvent.click(saveBtn);
		await waitFor(() => {
			expect(mockedApi.setQuickCommands).toHaveBeenCalledWith([
				{ name: "review", description: undefined, prompt: "new prompt" },
			]);
		});
	});

	it("Add command opens inline row and adding saves to server", async () => {
		mockedApi.getQuickCommands.mockResolvedValueOnce([]);
		renderPage();
		await waitFor(() => screen.getByText("Add command"));
		fireEvent.click(screen.getByText("Add command"));
		fireEvent.change(screen.getByLabelText("Command name"), { target: { value: "lint" } });
		fireEvent.change(screen.getByLabelText("Command prompt"), { target: { value: "Run linter" } });
		fireEvent.click(screen.getByText("Add"));
		fireEvent.click(screen.getByText("Save changes"));
		await waitFor(() => {
			expect(mockedApi.setQuickCommands).toHaveBeenCalledWith([
				{ name: "lint", description: undefined, prompt: "Run linter" },
			]);
		});
	});

	it("reserved name blocks saving", async () => {
		mockedApi.getQuickCommands.mockResolvedValueOnce([]);
		renderPage();
		await waitFor(() => screen.getByText("Add command"));
		fireEvent.click(screen.getByText("Add command"));
		fireEvent.change(screen.getByLabelText("Command name"), { target: { value: "compact" } });
		fireEvent.change(screen.getByLabelText("Command prompt"), { target: { value: "x" } });
		const addBtn = screen.getByText("Add") as HTMLButtonElement;
		expect(addBtn.disabled).toBe(true);
		expect(screen.getByText(/reserved/)).toBeTruthy();
	});
});