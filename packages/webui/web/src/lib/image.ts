export interface InputImage {
  id: string;
  mediaType: string;
  dataUrl: string;
  size: number;
  name?: string;
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;
const MAX_COUNT = 4;

export type ValidationResult =
  | { ok: true; image: InputImage }
  | { ok: false; reason: 'type' | 'size' | 'count' | 'total' };

export function validateImageFile(
  file: File,
  currentTotal: number,
  currentCount: number,
): ValidationResult {
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { ok: false, reason: 'type' };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, reason: 'size' };
  }

  if (currentCount >= MAX_COUNT) {
    return { ok: false, reason: 'count' };
  }

  if (currentTotal + file.size > MAX_TOTAL_SIZE) {
    return { ok: false, reason: 'total' };
  }

  return {
    ok: true,
    image: {
      id: crypto.randomUUID(),
      mediaType: file.type,
      dataUrl: '',
      size: file.size,
      name: file.name,
    },
  };
}

export function fileToBase64(file: File): Promise<{ mediaType: string; dataUrl: string; size: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        mediaType: file.type,
        dataUrl: reader.result as string,
        size: file.size,
      });
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
