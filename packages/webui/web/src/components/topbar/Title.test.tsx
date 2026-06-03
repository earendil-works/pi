/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { Title } from './Title';

describe('Title', () => {
  it('renders title text', () => {
    render(<Title title="Test Title" messageCount={5} />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('renders message count', () => {
    render(<Title title="Test Title" messageCount={5} />);
    expect(screen.getByText('5 messages')).toBeInTheDocument();
  });

  it('renders 0 messages correctly', () => {
    render(<Title title="Test Title" messageCount={0} />);
    expect(screen.getByText('0 messages')).toBeInTheDocument();
  });

  it('has correct heading class', () => {
    render(<Title title="Test Title" messageCount={5} />);
    const heading = screen.getByText('Test Title');
    expect(heading).toHaveClass('text-lg', 'font-semibold', 'text-stone-900');
  });

  it('has correct message count class', () => {
    render(<Title title="Test Title" messageCount={5} />);
    const count = screen.getByText('5 messages');
    expect(count).toHaveClass('text-xs', 'text-stone-500');
  });
});
