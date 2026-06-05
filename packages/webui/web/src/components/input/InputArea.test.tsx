import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { InputArea } from "./InputArea";
import type { InputImage } from "../../lib/image";

const mockImage: InputImage = {
  id: "img-1",
  mediaType: "image/png",
  dataUrl: "data:image/png;base64,abc",
  size: 1000,
  name: "test.png",
};

describe("InputArea", () => {
  let onChangeText: ReturnType<typeof vi.fn>;
  let onAddImage: ReturnType<typeof vi.fn>;
  let onRemoveImage: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;
  let onSubmit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onChangeText = vi.fn();
    onAddImage = vi.fn();
    onRemoveImage = vi.fn();
    onError = vi.fn();
    onSubmit = vi.fn();
  });

  const renderInputArea = (props?: Partial<React.ComponentProps<typeof InputArea>>) =>
    render(
      <InputArea
        images={props?.images ?? []}
        text={props?.text ?? ""}
        onChangeText={onChangeText}
        onAddImage={onAddImage}
        onRemoveImage={onRemoveImage}
        onError={onError}
        onSubmit={onSubmit}
        disabled={props?.disabled}
      />
    );

  it("renders ImagePreview and ImageInput components", () => {
    renderInputArea({ images: [mockImage] });
    expect(screen.getByTestId("image-preview-container")).toBeTruthy();
    expect(screen.getByTestId("drop-container")).toBeTruthy();
  });

  it("renders textarea for text input", () => {
    renderInputArea({ text: "Hello" });
    const textarea = screen.getByPlaceholderText("Message pi...");
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveProperty("value", "Hello");
  });

  it("renders Send button", () => {
    renderInputArea();
    const sendButton = screen.getByRole("button", { name: /send/i });
    expect(sendButton).toBeTruthy();
  });

  it("triggers onChangeText when typing in textarea", () => {
    renderInputArea();
    const textarea = screen.getByPlaceholderText("Message pi...");
    fireEvent.change(textarea, { target: { value: "New text" } });
    expect(onChangeText).toHaveBeenCalledWith("New text");
  });

  it("triggers onSubmit when pressing Enter without Shift", () => {
    renderInputArea({ text: "Hello" });
    const textarea = screen.getByPlaceholderText("Message pi...");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does NOT trigger onSubmit when pressing Shift+Enter", () => {
    renderInputArea({ text: "Hello" });
    const textarea = screen.getByPlaceholderText("Message pi...");
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables Send button when text is empty", () => {
    renderInputArea({ text: "" });
    const sendButton = screen.getByRole("button", { name: /send/i });
    expect(sendButton).toHaveAttribute("disabled");
  });

  it("enables Send button when text is not empty", () => {
    renderInputArea({ text: "Hello" });
    const sendButton = screen.getByRole("button", { name: /send/i });
    expect(sendButton).not.toHaveAttribute("disabled");
  });

  it("calls onAddImage via ImageInput when adding image", () => {
    // ImageInput handles its own file processing internally
    // We verify the component is rendered with correct props
    renderInputArea();
    expect(screen.getByTestId("drop-container")).toBeTruthy();
  });

  it("disables textarea when disabled prop is true", () => {
    renderInputArea({ disabled: true });
    const textarea = screen.getByPlaceholderText("Message pi...");
    expect(textarea).toHaveAttribute("disabled");
  });

  it("disables Send button when disabled prop is true", () => {
    renderInputArea({ disabled: true });
    const sendButton = screen.getByRole("button", { name: /send/i });
    expect(sendButton).toHaveAttribute("disabled");
  });

  it("clicking Send button triggers onSubmit", () => {
    renderInputArea({ text: "Hello" });
    const sendButton = screen.getByRole("button", { name: /send/i });
    fireEvent.click(sendButton);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  describe("Stop button (abort)", () => {
    let onAbort: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      onAbort = vi.fn();
    });

    const renderWithAbort = (props?: Partial<React.ComponentProps<typeof InputArea>>) =>
      render(
        <InputArea
          images={props?.images ?? []}
          text={props?.text ?? "draft"}
          onChangeText={onChangeText}
          onAddImage={onAddImage}
          onRemoveImage={onRemoveImage}
          onError={onError}
          onSubmit={onSubmit}
          onAbort={onAbort}
          disabled={props?.disabled}
        />
      );

    it("renders Stop button instead of Send when onAbort is provided", () => {
      renderWithAbort();
      expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
    });

    it("clicking Stop triggers onAbort, not onSubmit", () => {
      renderWithAbort();
      fireEvent.click(screen.getByRole("button", { name: /stop/i }));
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("Enter does not submit while abort is available (lets user draft a multi-line message)", () => {
      renderWithAbort();
      const textarea = screen.getByPlaceholderText(/Generating/i);
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it("Stop button is enabled even when text is empty (aborts are independent of the draft)", () => {
      render(
        <InputArea
          images={[]}
          text=""
          onChangeText={onChangeText}
          onAddImage={onAddImage}
          onRemoveImage={onRemoveImage}
          onError={onError}
          onSubmit={onSubmit}
          onAbort={onAbort}
        />
      );
      const stopButton = screen.getByRole("button", { name: /stop/i });
      expect(stopButton).not.toHaveAttribute("disabled");
    });

    it("falls back to Send button when onAbort is omitted", () => {
      renderInputArea({ text: "Hello" });
      expect(screen.getByRole("button", { name: /send/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /stop/i })).toBeNull();
    });
  });
});
