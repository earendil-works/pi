/// <reference types="vitest/globals" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { ModelSelector } from './ModelSelector';
import type { ModelsResponse } from '../../lib/api';

describe('ModelSelector', () => {
  const mockProviders: ModelsResponse["providers"] = [
    {
      name: "anthropic",
      models: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4" },
        { id: "claude-opus-4", name: "Claude Opus 4" },
      ],
    },
    {
      name: "openai",
      models: [
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-4o-mini", name: "GPT-4o Mini" },
      ],
    },
  ];

  const defaultProps = {
    current: { provider: "anthropic", model: "claude-sonnet-4-6" },
    providers: mockProviders,
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders current model in button', () => {
    render(<ModelSelector {...defaultProps} />);
    // Should show provider/model truncated - "claude-sonnet-4-6" is 17 chars, truncates to 16 + "..."
    expect(screen.getByRole('button')).toHaveTextContent('anthropic/claude-sonnet-4-...');
  });

  it('renders button with correct styling classes', () => {
    render(<ModelSelector {...defaultProps} />);
    const button = screen.getByRole('button');
    expect(button).toHaveClass('text-sm', 'bg-blue-100', 'text-blue-900', 'px-3', 'py-1', 'rounded-full', 'font-medium', 'hover:bg-blue-200');
  });

  it('opens dropdown when button is clicked', async () => {
    const user = userEvent.setup();
    render(<ModelSelector {...defaultProps} />);
    
    await user.click(screen.getByRole('button'));
    
    // Dropdown should be visible with provider names
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
  });

  it('shows model items under each provider', async () => {
    const user = userEvent.setup();
    render(<ModelSelector {...defaultProps} />);
    
    await user.click(screen.getByRole('button'));
    
    // Model items should be visible
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
    expect(screen.getByText('GPT-4o')).toBeInTheDocument();
  });

  it('calls onChange with correct selection when a model is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelSelector {...defaultProps} onChange={onChange} />);
    
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByText('GPT-4o'));
    
    expect(onChange).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o' });
  });

  it('closes dropdown after selecting a model', async () => {
    const user = userEvent.setup();
    render(<ModelSelector {...defaultProps} />);
    
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    
    await user.click(screen.getByText('GPT-4o'));
    expect(screen.queryByText('openai')).not.toBeInTheDocument();
  });

  it('closes dropdown when clicking outside', async () => {
    const user = userEvent.setup();
    render(<ModelSelector {...defaultProps} />);
    
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    
    // Click outside the component
    await user.click(document.body);
    expect(screen.queryByText('openai')).not.toBeInTheDocument();
  });

  it('truncates long model names to 16 characters', () => {
    const longModelProps = {
      ...defaultProps,
      current: { provider: "test", model: "this-is-a-very-long-model-name-that-exceeds-16-chars" },
    };
    render(<ModelSelector {...longModelProps} />);
    expect(screen.getByRole('button')).toHaveTextContent('test/this-is-a-very-l...');
  });

  it('does not truncate short model names', () => {
    const shortModelProps = {
      ...defaultProps,
      current: { provider: "test", model: "short" },
    };
    render(<ModelSelector {...shortModelProps} />);
    expect(screen.getByRole('button')).toHaveTextContent('test/short');
  });

  it('highlights currently selected model', async () => {
    const user = userEvent.setup();
    render(<ModelSelector {...defaultProps} />);
    
    await user.click(screen.getByRole('button'));
    
    // The selected model button should have active styling
    const selectedButton = screen.getByRole('button', { name: 'Claude Sonnet 4' });
    expect(selectedButton).toHaveClass('bg-blue-50', 'text-blue-900');
  });

  it('renders dropdown with correct positioning and styling', async () => {
    const user = userEvent.setup();
    render(<ModelSelector {...defaultProps} />);
    
    await user.click(screen.getByRole('button'));
    
    const dropdown = document.querySelector('.absolute.right-0.mt-1.w-64.bg-white.border.rounded-md.shadow-lg.z-20');
    expect(dropdown).toBeInTheDocument();
  });

  it('renders each model item with correct button styling', async () => {
    const user = userEvent.setup();
    render(<ModelSelector {...defaultProps} />);
    
    await user.click(screen.getByRole('button'));
    
    const modelButton = screen.getByRole('button', { name: 'Claude Sonnet 4' });
    expect(modelButton).toHaveClass('w-full', 'text-left', 'px-3', 'py-2', 'hover:bg-stone-100');
  });
});
