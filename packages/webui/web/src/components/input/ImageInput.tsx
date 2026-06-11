import { useRef, useState, useEffect } from "react";
import { validateImageFile, fileToBase64, type InputImage } from "../../lib/image";

const PaperclipIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
    <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94a3 3 0 1 1 4.243 4.243l-6.182 6.182a4.5 4.5 0 0 0 5.156 5.156l.575-.575" />
  </svg>
);

interface ImageInputProps {
  images: InputImage[];
  onAdd: (image: InputImage) => void;
  onError: (reason: "type" | "size" | "count" | "total") => void;
}

export function ImageInput({ images, onAdd, onError }: ImageInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const processFile = async (file: File): Promise<void> => {
    const total = images.reduce((sum, img) => sum + img.size, 0);
    const result = validateImageFile(file, total, images.length);
    if (!result.ok) {
      onError(result.reason);
      return;
    }
    const { mediaType, dataUrl, size } = await fileToBase64(file);
    onAdd({ id: crypto.randomUUID(), mediaType, dataUrl, size, name: file.name });
  };

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(processFile);
  };

  const handlePaste = (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) processFile(file);
      }
    }
  };

  useEffect(() => {
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [images]);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <div
      data-testid="drop-container"
      className="relative"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="text-stone-500 hover:text-stone-700 hover:bg-stone-100 p-2 rounded-md"
        aria-label="Attach image"
      >
        <PaperclipIcon />
      </button>

      <input
        ref={fileInputRef}
        data-testid="file-input"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        onChange={(e) => handleFiles(e.target.files)}
        className="hidden"
      />

      {isDragging && (
        <div
          data-testid="drag-highlight"
          className="absolute inset-0 pointer-events-none border-2 border-dashed border-blue-500 rounded-md"
        />
      )}
    </div>
  );
}
