import { useRef, useEffect } from "react";
import { ImageInput } from "./ImageInput";
import ImagePreview from "./ImagePreview";
import type { InputImage } from "../../lib/image";

const SendIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={1.5}
    stroke="currentColor"
    className="w-4 h-4"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"
    />
  </svg>
);

interface InputAreaProps {
  images: InputImage[];
  text: string;
  onChangeText: (text: string) => void;
  onAddImage: (image: InputImage) => void;
  onRemoveImage: (id: string) => void;
  onError: (reason: "type" | "size" | "count" | "total") => void;
  onSubmit: () => void;
  disabled?: boolean;
}

export function InputArea({
  images,
  text,
  onChangeText,
  onAddImage,
  onRemoveImage,
  onError,
  onSubmit,
  disabled,
}: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea up to maxHeight 120px
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      const newHeight = Math.min(textarea.scrollHeight, 120);
      textarea.style.height = `${newHeight}px`;
    }
  }, [text]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="border-t border-stone-200 bg-stone-50">
      <ImagePreview images={images} onRemove={onRemoveImage} />
      <div className="flex gap-2 items-end p-3">
        <ImageInput images={images} onAdd={onAddImage} onError={onError} />
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none rounded-md border border-stone-300 px-3 py-2 text-sm"
          value={text}
          onChange={(e) => onChangeText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message pi..."
          rows={1}
          disabled={disabled}
          style={{ maxHeight: "120px" }}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled || !text.trim()}
          className="p-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          aria-label="Send"
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
