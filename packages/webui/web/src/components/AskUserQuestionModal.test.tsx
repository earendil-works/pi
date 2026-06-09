/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import * as React from "react";
import AskUserQuestionModal from "./AskUserQuestionModal";

describe("AskUserQuestionModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. renders question + options
  it("renders question + options", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <AskUserQuestionModal
        isOpen={true}
        question="Pick one"
        options={[
          { label: "Option 1", description: "desc 1" },
          { label: "Option 2" },
        ]}
        multiSelect={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    expect(screen.getByText("Pick one")).toBeInTheDocument();
    expect(screen.getByText("Option 1")).toBeInTheDocument();
    expect(screen.getByText("desc 1")).toBeInTheDocument();
  });

  // 2. single-select click option → onSubmit(label)
  it("single-select click option → onSubmit(label)", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <AskUserQuestionModal
        isOpen={true}
        question="Pick one"
        options={[
          { label: "Option 1", description: "desc 1" },
          { label: "Option 2" },
        ]}
        multiSelect={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByText("Option 1"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Option 1");
  });

  // 3. multi-select check 2 + submit → onSubmit("label1, label2")
  it("multi-select check 2 + submit → onSubmit(label1, label2)", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <AskUserQuestionModal
        isOpen={true}
        question="Pick one"
        options={[
          { label: "Option 1", description: "desc 1" },
          { label: "Option 2" },
        ]}
        multiSelect={true}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    // Click both options (checkboxes in multi-select mode)
    fireEvent.click(screen.getByText("Option 1"));
    fireEvent.click(screen.getByText("Option 2"));

    // Submit button should be present
    const submitBtn = screen.getByRole("button", { name: /submit/i });
    fireEvent.click(submitBtn);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Option 1, Option 2");
  });

  // 4. Cancel button → onCancel
  it("Cancel button → onCancel", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <AskUserQuestionModal
        isOpen={true}
        question="Pick one"
        options={[{ label: "Option 1" }]}
        multiSelect={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // 5. Esc key → onCancel
  it("Esc key → onCancel", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <AskUserQuestionModal
        isOpen={true}
        question="Pick one"
        options={[{ label: "Option 1" }]}
        multiSelect={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // 6. not rendered when isOpen=false
  it("not rendered when isOpen=false", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <AskUserQuestionModal
        isOpen={false}
        question="Pick one"
        options={[{ label: "Option 1" }]}
        multiSelect={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    expect(screen.queryByText("Pick one")).toBeNull();
  });
});
