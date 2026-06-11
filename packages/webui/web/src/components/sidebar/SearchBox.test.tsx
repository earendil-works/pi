import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SearchBox } from './SearchBox';

describe('SearchBox', () => {
  it('renders with correct placeholder text', () => {
    render(<SearchBox value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('Filter conversations...')).toBeInTheDocument();
  });

  it('displays the initial value', () => {
    render(<SearchBox value="test query" onChange={vi.fn()} />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveValue('test query');
  });

  it('calls onChange when user types', () => {
    const onChange = vi.fn();
    render(<SearchBox value="" onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('hello');
  });

  it('renders search icon', () => {
    render(<SearchBox value="" onChange={vi.fn()} />);
    const icon = document.querySelector('svg');
    expect(icon).toBeInTheDocument();
  });
});
