import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateImageFile, fileToBase64, InputImage } from './image';

describe('validateImageFile', () => {
  const createFile = (name: string, type: string, size: number): File => {
    const blob = new Blob([], { type });
    Object.defineProperty(blob, 'size', { value: size });
    Object.defineProperty(blob, 'name', { value: name });
    Object.defineProperty(blob, 'type', { value: type });
    return blob as File;
  };

  describe('type validation', () => {
    it('S55: rejects bmp image', () => {
      const file = createFile('test.bmp', 'image/bmp', 1000);
      const result = validateImageFile(file, 0, 0);
      expect(result).toMatchObject({ ok: false, reason: 'type' });
    });

    it('accepts png', () => {
      const file = createFile('test.png', 'image/png', 1000);
      const result = validateImageFile(file, 0, 0);
      expect(result.ok).toBe(true);
    });

    it('accepts jpeg', () => {
      const file = createFile('test.jpg', 'image/jpeg', 1000);
      const result = validateImageFile(file, 0, 0);
      expect(result.ok).toBe(true);
    });

    it('accepts gif', () => {
      const file = createFile('test.gif', 'image/gif', 1000);
      const result = validateImageFile(file, 0, 0);
      expect(result.ok).toBe(true);
    });

    it('accepts webp', () => {
      const file = createFile('test.webp', 'image/webp', 1000);
      const result = validateImageFile(file, 0, 0);
      expect(result.ok).toBe(true);
    });
  });

  describe('size validation', () => {
    it('S56: rejects file larger than 5MB', () => {
      const file = createFile('test.png', 'image/png', 5 * 1024 * 1024 + 1);
      const result = validateImageFile(file, 0, 0);
      expect(result).toMatchObject({ ok: false, reason: 'size' });
    });

    it('accepts file at exactly 5MB', () => {
      const file = createFile('test.png', 'image/png', 5 * 1024 * 1024);
      const result = validateImageFile(file, 0, 0);
      expect(result.ok).toBe(true);
    });
  });

  describe('count validation', () => {
    it('S57: rejects when already 4 images (currentCount >= 4)', () => {
      const file = createFile('test.png', 'image/png', 1000);
      const result = validateImageFile(file, 0, 4);
      expect(result).toMatchObject({ ok: false, reason: 'count' });
    });

    it('accepts when 3 images (currentCount = 3)', () => {
      const file = createFile('test.png', 'image/png', 1000);
      const result = validateImageFile(file, 0, 3);
      expect(result.ok).toBe(true);
    });
  });

  describe('total size validation', () => {
    it('S58: rejects when currentTotal + file.size > 20MB', () => {
      const file = createFile('test.png', 'image/png', 2 * 1024 * 1024);
      const result = validateImageFile(file, 19 * 1024 * 1024, 0);
      expect(result).toMatchObject({ ok: false, reason: 'total' });
    });

    it('accepts when currentTotal + file.size <= 20MB', () => {
      const file = createFile('test.png', 'image/png', 1 * 1024 * 1024);
      const result = validateImageFile(file, 19 * 1024 * 1024, 0);
      expect(result.ok).toBe(true);
    });
  });

  describe('successful validation', () => {
    it('returns InputImage with id, mediaType, empty dataUrl, size, name', () => {
      const file = createFile('my-image.png', 'image/png', 1024);
      const result = validateImageFile(file, 0, 0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.image.id).toBeDefined();
        expect(result.image.mediaType).toBe('image/png');
        expect(result.image.dataUrl).toBe('');
        expect(result.image.size).toBe(1024);
        expect(result.image.name).toBe('my-image.png');
      }
    });
  });
});

describe('fileToBase64', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with mediaType, dataUrl, and size', async () => {
    const blob = new Blob(['fake-image-data'], { type: 'image/png' });
    const file = blob as File;

    const mockReader = {
      result: 'data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh',
      onload: null as ((() => void) | null),
      onerror: null as ((() => void) | null),
      readAsDataURL: function (f: File) {
        // Simulate async load
        setTimeout(() => {
          if (mockReader.onload) {
            mockReader.onload();
          }
        }, 0);
      },
      addEventListener: function (event: string, handler: () => void) {
        if (event === 'load') {
          mockReader.onload = handler;
        } else if (event === 'error') {
          mockReader.onerror = handler;
        }
      },
    };

    vi.spyOn(global, 'FileReader' as any).mockImplementation(() => mockReader as any);

    const promise = fileToBase64(file);
    const result = await promise;

    expect(result.mediaType).toBe('image/png');
    expect(result.dataUrl).toBe('data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh');
    // Blob created with 'fake-image-data' has size 15
    expect(result.size).toBe(15);
  });

  it('rejects on error', async () => {
    const blob = new Blob(['fake-image-data'], { type: 'image/png' });
    const file = blob as File;

    const mockReader = {
      result: '',
      onload: null as ((() => void) | null),
      onerror: null as ((() => void) | null),
      readAsDataURL: function (f: File) {
        setTimeout(() => {
          if (mockReader.onerror) {
            mockReader.onerror();
          }
        }, 0);
      },
      addEventListener: function (event: string, handler: () => void) {
        if (event === 'load') {
          mockReader.onload = handler;
        } else if (event === 'error') {
          mockReader.onerror = handler;
        }
      },
    };

    vi.spyOn(global, 'FileReader' as any).mockImplementation(() => mockReader as any);

    const promise = fileToBase64(file);
    await expect(promise).rejects.toThrow('Failed to read file');
  });
});
