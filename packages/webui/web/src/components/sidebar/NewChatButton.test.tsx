import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { NewChatButton } from './NewChatButton';

describe('NewChatButton', () => {
  it('renders with "New conversation" text', () => {
    render(<NewChatButton onClick={vi.fn()} />);
    expect(screen.getByText('New conversation')).toBeInTheDocument();
  });

  it('renders Plus icon when not loading', () => {
    render(<NewChatButton onClick={vi.fn()} />);
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('renders Loader2 icon when loading', () => {
    render(<NewChatButton onClick={vi.fn()} loading={true} />);
    const svg = document.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<NewChatButton onClick={onClick} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not call onClick when disabled', () => {
    const onClick = vi.fn();
    render(<NewChatButton onClick={onClick} disabled={true} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not call onClick when loading', () => {
    const onClick = vi.fn();
    render(<NewChatButton onClick={onClick} loading={true} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('button is disabled when loading is true', () => {
    render(<NewChatButton onClick={vi.fn()} loading={true} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('button is disabled when disabled is true', () => {
    render(<NewChatButton onClick={vi.fn()} disabled={true} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
