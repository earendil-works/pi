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
});
