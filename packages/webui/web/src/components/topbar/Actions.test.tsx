/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { Actions } from './Actions';

describe('Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders clear and settings buttons', () => {
    render(<Actions onClear={vi.fn()} onSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /settings/i })).toBeInTheDocument();
  });

  it('calls onClear when clear button is clicked and confirmed', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    vi.stubGlobal('confirm', vi.fn(() => true));

    render(<Actions onClear={onClear} onSettings={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /clear/i }));

    expect(confirm).toHaveBeenCalledWith('Clear messages?');
    expect(onClear).toHaveBeenCalled();
  });

  it('does not call onClear when confirm is dismissed', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    vi.stubGlobal('confirm', vi.fn(() => false));

    render(<Actions onClear={onClear} onSettings={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /clear/i }));

    expect(onClear).not.toHaveBeenCalled();
  });

  it('calls onSettings when settings button is clicked', async () => {
    const user = userEvent.setup();
    const onSettings = vi.fn();

    render(<Actions onClear={vi.fn()} onSettings={onSettings} />);
    await user.click(screen.getByRole('button', { name: /settings/i }));

    expect(onSettings).toHaveBeenCalled();
  });

  it('clear button has correct styling classes', () => {
    render(<Actions onClear={vi.fn()} onSettings={vi.fn()} />);
    const clearBtn = screen.getByRole('button', { name: /clear/i });
    expect(clearBtn).toHaveClass('text-sm', 'text-stone-500', 'hover:text-stone-700', 'hover:bg-stone-100', 'px-3', 'py-2', 'rounded-md');
  });

  it('settings button has correct styling classes', () => {
    render(<Actions onClear={vi.fn()} onSettings={vi.fn()} />);
    const settingsBtn = screen.getByRole('button', { name: /settings/i });
    expect(settingsBtn).toHaveClass('text-stone-500', 'hover:text-stone-700', 'hover:bg-stone-100', 'p-2', 'rounded-md');
  });
});
