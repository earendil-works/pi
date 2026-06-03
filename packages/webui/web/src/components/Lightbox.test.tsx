import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';
import { Lightbox } from './Lightbox';

const mockImage = { url: 'https://example.com/image.jpg', alt: 'Test image' };

describe('Lightbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when image is null', () => {
    const { container } = render(<Lightbox image={null} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when image is undefined', () => {
    const { container } = render(<Lightbox image={undefined} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders image in a portal to document.body', () => {
    render(<Lightbox image={mockImage} onClose={vi.fn()} />);
    const portal = document.body.querySelector('.fixed.inset-0.z-50');
    expect(portal).toBeTruthy();
  });

  it('renders backdrop with dark overlay', () => {
    render(<Lightbox image={mockImage} onClose={vi.fn()} />);
    const backdrop = document.body.querySelector('.absolute.inset-0.bg-black\\/90');
    expect(backdrop).toBeTruthy();
  });

  it('renders image with correct src and alt', () => {
    render(<Lightbox image={mockImage} onClose={vi.fn()} />);
    const img = document.body.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe(mockImage.url);
    expect(img?.getAttribute('alt')).toBe(mockImage.alt);
  });

  it('renders img with loading lazy', () => {
    render(<Lightbox image={mockImage} onClose={vi.fn()} />);
    const img = document.body.querySelector('img');
    expect(img?.getAttribute('loading')).toBe('lazy');
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<Lightbox image={mockImage} onClose={onClose} />);
    const backdrop = document.body.querySelector('.absolute.inset-0.bg-black\\/90');
    backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when ESC key is pressed', () => {
    const onClose = vi.fn();
    render(<Lightbox image={mockImage} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when other keys are pressed', () => {
    const onClose = vi.fn();
    render(<Lightbox image={mockImage} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not call onClose when image is null', () => {
    const onClose = vi.fn();
    render(<Lightbox image={null} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cleans up ESC listener on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Lightbox image={mockImage} onClose={onClose} />);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
