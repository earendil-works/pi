import * as React from 'react';
import { createPortal } from 'react-dom';

interface LightboxProps {
  image: { url: string; alt?: string } | null;
  onClose: () => void;
}

export function Lightbox({ image, onClose }: LightboxProps) {
  if (image == null) {
    return null;
  }

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/90"
        onClick={onClose}
      />
      <img
        className="relative max-w-[90vw] max-h-[90vh] object-contain"
        src={image.url}
        alt={image.alt}
        loading="lazy"
      />
    </div>,
    document.body
  );
}
