/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import ImagePreview from "./ImagePreview";
import type { InputImage } from "../../lib/image";

function createMockImage(overrides: Partial<InputImage> = {}): InputImage {
  return {
    id: "img-1",
    mediaType: "image/png",
    dataUrl: "data:image/png;base64,mockdata",
    size: 1024,
    name: "test.png",
    ...overrides,
  };
}

describe("ImagePreview", () => {
  describe("empty array", () => {
    it("should return null when images array is empty", () => {
      const { container } = render(<ImagePreview images={[]} onRemove={vi.fn()} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("with images", () => {
    it("should render all images with correct structure", () => {
      const images: InputImage[] = [
        createMockImage({ id: "img-1", name: "first.png" }),
        createMockImage({ id: "img-2", name: "second.png" }),
      ];
      const onRemove = vi.fn();

      render(<ImagePreview images={images} onRemove={onRemove} />);

      const previews = screen.getAllByRole("img");
      expect(previews).toHaveLength(2);
      expect(previews[0]).toHaveAttribute("src", "data:image/png;base64,mockdata");
      expect(previews[0]).toHaveAttribute("alt", "first.png");
      expect(previews[1]).toHaveAttribute("alt", "second.png");
    });

    it("should use 'preview' as alt text when name is not provided", () => {
      const images: InputImage[] = [createMockImage({ id: "img-1", name: undefined })];
      render(<ImagePreview images={images} onRemove={vi.fn()} />);

      expect(screen.getByRole("img")).toHaveAttribute("alt", "preview");
    });

    it("should render remove button for each image with correct aria-label", () => {
      const images: InputImage[] = [
        createMockImage({ id: "img-1" }),
        createMockImage({ id: "img-2" }),
      ];
      const onRemove = vi.fn();

      render(<ImagePreview images={images} onRemove={onRemove} />);

      const removeButtons = screen.getAllByRole("button", { name: /remove/i });
      expect(removeButtons).toHaveLength(2);
    });

    it("should call onRemove with correct id when remove button is clicked", () => {
      const images: InputImage[] = [
        createMockImage({ id: "img-to-remove" }),
        createMockImage({ id: "img-to-keep" }),
      ];
      const onRemove = vi.fn();

      render(<ImagePreview images={images} onRemove={onRemove} />);

      const removeButton = screen.getAllByRole("button", { name: /remove/i })[0];
      fireEvent.click(removeButton);

      expect(onRemove).toHaveBeenCalledWith("img-to-remove");
    });

    it("should render remove button text as ×", () => {
      const images: InputImage[] = [createMockImage({ id: "img-1" })];
      render(<ImagePreview images={images} onRemove={vi.fn()} />);

      expect(screen.getByText("×")).toBeInTheDocument();
    });
  });
});
