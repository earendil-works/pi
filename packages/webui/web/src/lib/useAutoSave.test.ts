import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutoSave } from "./useAutoSave";

describe("useAutoSave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("saves after debounce delay when value changes", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ value }) => useAutoSave(value, { onSave, delay: 1000 }),
			{ initialProps: { value: "a" } },
		);
		expect(onSave).not.toHaveBeenCalled();
		rerender({ value: "b" });
		expect(onSave).not.toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(onSave).toHaveBeenCalledWith("b");
		expect(onSave).toHaveBeenCalledTimes(1);
	});

	it("debounces: multiple rapid changes only trigger one save", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { rerender } = renderHook(
			({ value }) => useAutoSave(value, { onSave, delay: 1000 }),
			{ initialProps: { value: "a" } },
		);
		rerender({ value: "b" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		rerender({ value: "c" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		rerender({ value: "d" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave).toHaveBeenCalledWith("d");
	});

	it("status transitions: idle → saving → saved", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ value }) => useAutoSave(value, { onSave, delay: 100 }),
			{ initialProps: { value: "a" } },
		);
		expect(result.current.status).toBe("idle");
		rerender({ value: "b" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
		expect(result.current.status).toBe("saved");
		expect(result.current.savedValue).toBe("b");
	});

	it("status transitions to error when onSave throws", async () => {
		const onSave = vi.fn().mockRejectedValue(new Error("boom"));
		const { result, rerender } = renderHook(
			({ value }) => useAutoSave(value, { onSave, delay: 100 }),
			{ initialProps: { value: "a" } },
		);
		rerender({ value: "b" });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(100);
		});
		expect(result.current.status).toBe("error");
		expect(result.current.error?.message).toBe("boom");
	});

	it("flush() triggers immediate save bypassing debounce", async () => {
		const onSave = vi.fn().mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ value }) => useAutoSave(value, { onSave, delay: 10000 }),
			{ initialProps: { value: "a" } },
		);
		rerender({ value: "b" });
		expect(onSave).not.toHaveBeenCalled();
		await act(async () => {
			await result.current.flush();
		});
		expect(onSave).toHaveBeenCalledWith("b");
	});
});
