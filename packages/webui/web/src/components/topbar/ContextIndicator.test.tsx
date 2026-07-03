/// <reference types="vitest/globals" />
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContextIndicator } from "./ContextIndicator";

describe("ContextIndicator", () => {
  it("renders nothing when tokens is undefined", () => {
    const { container } = render(<ContextIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("renders formatted token chip with 'ctx' suffix when tokens is a number", () => {
    render(<ContextIndicator tokens={52400} />);
    const chip = screen.getByTestId("context-tokens");
    // formatToken(52400) → "52.4K"
    expect(chip).toHaveTextContent("52.4K ctx");
  });

  it("formats millions and billions consistently with formatToken", () => {
    const { rerender } = render(<ContextIndicator tokens={1_500_000} />);
    expect(screen.getByTestId("context-tokens")).toHaveTextContent("1.5M ctx");
    rerender(<ContextIndicator tokens={2_500_000_000} />);
    expect(screen.getByTestId("context-tokens")).toHaveTextContent("2.5B ctx");
  });

  it("uses amber pill styling so the chip reads as a peer of ModelSelector's blue pill", () => {
    render(<ContextIndicator tokens={1500} />);
    const chip = screen.getByTestId("context-tokens");
    expect(chip).toHaveClass("bg-amber-100", "text-amber-900", "rounded-full");
  });

  // "Used / total" is the preferred reading once the model's context
  // window is known — without it the user has no sense of how close
  // they are to compaction.
  it("renders 'used / total' when contextWindow is provided", () => {
    render(<ContextIndicator tokens={52400} contextWindow={200000} />);
    const chip = screen.getByTestId("context-tokens");
    // formatToken abbreviates both numbers independently
    expect(chip).toHaveTextContent("52.4K / 200.0K ctx");
  });

  it("falls back to 'used only' when contextWindow is 0 or negative", () => {
    const { rerender } = render(<ContextIndicator tokens={52400} contextWindow={0} />);
    expect(screen.getByTestId("context-tokens")).toHaveTextContent("52.4K ctx");
    rerender(<ContextIndicator tokens={52400} contextWindow={-1} />);
    expect(screen.getByTestId("context-tokens")).toHaveTextContent("52.4K ctx");
    rerender(<ContextIndicator tokens={52400} contextWindow={Number.POSITIVE_INFINITY} />);
    expect(screen.getByTestId("context-tokens")).toHaveTextContent("52.4K ctx");
  });

  it("tooltip on 'used / total' mode lists both numbers verbatim", () => {
    render(<ContextIndicator tokens={52400} contextWindow={200000} />);
    const chip = screen.getByTestId("context-tokens");
    // Browser tooltip text doesn't surface in jsdom, but the attribute
    // does. Verify the raw values rather than the abbreviated display
    // form, so the user sees exact token counts on hover.
    expect(chip.getAttribute("title")).toBe(
      "Most recent prompt: 52,400 of 200,000 tokens sent to the model",
    );
  });
});
