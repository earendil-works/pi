/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import { ImageInput } from "./ImageInput";
import type { InputImage } from "../../lib/image";

const mockOnAdd = vi.fn();
const mockOnError = vi.fn();

const createMockFile = (name: string, type: string, size: number): File => {
  const blob = new Blob([], { type });
  Object.defineProperty(blob, "size", { value: size });
  Object.defineProperty(blob, "name", { value: name });
  Object.defineProperty(blob, "type", { value: type });
  return blob as File;
};

describe("ImageInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  const setup = (images: InputImage[] = []) => {
    return render(
      <ImageInput images={images} onAdd={mockOnAdd} onError={mockOnError} />
    );
  };

  describe("Rendering", () => {
    it("renders Paperclip button with correct styling", () => {
      setup();
      const button = screen.getByRole("button");
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass("text-stone-500");
      expect(button).toHaveAttribute("aria-label", "Attach image");
    });

    it("renders hidden file input with correct attributes", () => {
      setup();
      const input = screen.getByTestId("file-input");
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute("type", "file");
      expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/gif,image/webp");
      expect(input).toHaveAttribute("multiple");
    });
  });

  describe("File Input Trigger", () => {
    it("clicking paperclip triggers file input click", async () => {
      const user = userEvent.setup();
      setup();
      const button = screen.getByRole("button");
      const input = screen.getByTestId("file-input");

      const clickSpy = vi.spyOn(input, "click");
      await user.click(button);

      expect(clickSpy).toHaveBeenCalled();
    });
  });

  describe("Drag and Drop", () => {
    it("shows drag highlight on dragover", async () => {
      setup();
      const container = screen.getByTestId("drop-container");

      fireEvent.dragOver(container);

      const highlight = screen.getByTestId("drag-highlight");
      expect(highlight).toBeInTheDocument();
    });

    it("removes drag highlight on dragleave", async () => {
      setup();
      const container = screen.getByTestId("drop-container");

      fireEvent.dragOver(container);
      fireEvent.dragLeave(container);

      const highlight = screen.queryByTestId("drag-highlight");
      expect(highlight).not.toBeInTheDocument();
    });

    it("processes dropped image files", async () => {
      setup();
      const container = screen.getByTestId("drop-container");

      const file = createMockFile("test.png", "image/png", 1024);

      fireEvent.drop(container, {
        dataTransfer: {
          files: [file],
          types: ["Files"],
        },
      });

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            id: expect.any(String),
            mediaType: "image/png",
            name: "test.png",
            size: 1024,
          })
        );
      });
    });

    it("rejects dropped non-image files with type error", async () => {
      setup();
      const container = screen.getByTestId("drop-container");

      const file = createMockFile("doc.pdf", "application/pdf", 1024);

      fireEvent.drop(container, {
        dataTransfer: {
          files: [file],
          types: ["Files"],
        },
      });

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith("type");
        expect(mockOnAdd).not.toHaveBeenCalled();
      });
    });
  });

  describe("Paste Handling", () => {
    it("adds pasted image file via onAdd", async () => {
      setup();
      const file = createMockFile("pasted.png", "image/png", 2048);

      const clipboardData = {
        items: [
          { kind: "file", type: "image/png", getAsFile: () => file },
        ],
        files: [],
      };

      fireEvent.paste(document, { clipboardData });

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            id: expect.any(String),
            mediaType: "image/png",
            name: "pasted.png",
            size: 2048,
          })
        );
      });
    });

    it("ignores pasted non-image files silently", async () => {
      setup();
      const file = createMockFile("doc.pdf", "application/pdf", 1024);

      const clipboardData = {
        items: [
          { kind: "file", type: "application/pdf", getAsFile: () => file },
        ],
        files: [],
      };

      fireEvent.paste(document, { clipboardData });

      // Non-image files are filtered out silently
      await waitFor(() => {
        expect(mockOnError).not.toHaveBeenCalled();
        expect(mockOnAdd).not.toHaveBeenCalled();
      });
    });
  });

  describe("File Type Validation", () => {
    it("rejects non-image file via onError with type reason", async () => {
      setup();
      const input = screen.getByTestId("file-input");

      const file = createMockFile("doc.pdf", "application/pdf", 1024);

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith("type");
        expect(mockOnAdd).not.toHaveBeenCalled();
      });
    });
  });

  describe("Image Count Limit", () => {
    it("rejects adding 5th image with count reason", async () => {
      const existingImages: InputImage[] = Array(4).fill(null).map((_, i) => ({
        id: `img-${i}`,
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,abc",
        size: 1000,
        name: `img-${i}.png`,
      }));

      setup(existingImages);
      const input = screen.getByTestId("file-input");

      const file = createMockFile("new.png", "image/png", 1024);

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith("count");
        expect(mockOnAdd).not.toHaveBeenCalled();
      });
    });

    it("allows adding 4th image", async () => {
      const existingImages: InputImage[] = Array(3).fill(null).map((_, i) => ({
        id: `img-${i}`,
        mediaType: "image/png",
        dataUrl: "data:image/png;base64,abc",
        size: 1000,
        name: `img-${i}.png`,
      }));

      setup(existingImages);
      const input = screen.getByTestId("file-input");

      const file = createMockFile("fourth.png", "image/png", 1024);

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(mockOnAdd).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("Total Size Validation", () => {
    it("rejects when total would exceed limit", async () => {
      const existingImages: InputImage[] = [
        {
          id: "img-1",
          mediaType: "image/png",
          dataUrl: "data:image/png;base64,abc",
          size: 18 * 1024 * 1024, // 18MB
          name: "img-1.png",
        },
      ];

      setup(existingImages);
      const input = screen.getByTestId("file-input");

      const file = createMockFile("new.png", "image/png", 5 * 1024 * 1024); // 5MB

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(mockOnError).toHaveBeenCalledWith("total");
        expect(mockOnAdd).not.toHaveBeenCalled();
      });
    });
  });
});
