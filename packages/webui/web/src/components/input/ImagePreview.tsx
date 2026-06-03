import type { InputImage } from "../../lib/image";

interface ImagePreviewProps {
  images: InputImage[];
  onRemove: (id: string) => void;
}

export default function ImagePreview({ images, onRemove }: ImagePreviewProps) {
  if (images.length === 0) {
    return null;
  }

  return (
    <div data-testid="image-preview-container" className="flex flex-wrap gap-2 px-3 py-2">
      {images.map((image) => (
        <div
          key={image.id}
          className="relative w-20 h-20 rounded overflow-hidden border border-stone-200"
        >
          <img
            className="w-full h-full object-cover"
            src={image.dataUrl}
            alt={image.name ?? "preview"}
          />
          <button
            type="button"
            className="absolute top-0 right-0 bg-black/50 text-white w-5 h-5 flex items-center justify-center text-xs rounded-bl-md"
            aria-label="Remove"
            onClick={() => onRemove(image.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
