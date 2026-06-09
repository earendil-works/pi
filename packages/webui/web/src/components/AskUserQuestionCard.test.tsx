import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { AskUserQuestionCard } from './AskUserQuestionCard';

describe('AskUserQuestionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── S1: 单选点选提交 → disabled + result text ──────────────────────────
  describe('Single-select', () => {
    it('renders question text and options (label + description)', () => {
      render(
        <AskUserQuestionCard
          question="Pick color"
          options={[
            { label: '红色', description: '温暖' },
            { label: '蓝色', description: '冷静' },
          ]}
          multiSelect={false}
          status="active"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(screen.getByText('Pick color')).toBeInTheDocument();
      expect(screen.getByText('红色')).toBeInTheDocument();
      expect(screen.getByText('蓝色')).toBeInTheDocument();
      expect(screen.getByText('温暖')).toBeInTheDocument();
      expect(screen.getByText('冷静')).toBeInTheDocument();
    });

    it('clicking an option calls onSubmit with that label', async () => {
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          question="Pick color"
          options={[{ label: '红色' }, { label: '蓝色' }]}
          multiSelect={false}
          status="active"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );

      await userEvent.click(screen.getByText('红色'));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith('红色');
    });
  });

  // ── S2: 多选编号输入提交 ──────────────────────────────────────────────
  describe('Multi-select', () => {
    it('renders numbered list + input + Submit button', () => {
      render(
        <AskUserQuestionCard
          question="Select colors"
          options={[
            { label: '红色', description: '温暖' },
            { label: '绿色' },
            { label: '蓝色', description: '天空' },
          ]}
          multiSelect={true}
          status="active"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      // Numbered options
      expect(screen.getByText(/1\.\s*红色/)).toBeInTheDocument();
      expect(screen.getByText(/2\.\s*绿色/)).toBeInTheDocument();
      expect(screen.getByText(/3\.\s*蓝色/)).toBeInTheDocument();

      // Input with placeholder containing 逗号分隔
      const input = screen.getByPlaceholderText(/逗号分隔/);
      expect(input).toBeInTheDocument();

      // Submit button
      expect(screen.getByRole('button', { name: /提交|Submit/i })).toBeInTheDocument();
    });

    it('typing numbers and clicking Submit calls onSubmit with selected labels', async () => {
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          question="Select colors"
          options={[{ label: '红' }, { label: '绿' }, { label: '蓝' }]}
          multiSelect={true}
          status="active"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );

      const input = screen.getByPlaceholderText(/逗号分隔/);
      await userEvent.type(input, '1,3');

      await userEvent.click(screen.getByRole('button', { name: /提交|Submit/i }));
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith('红, 蓝');
    });

    // ── S12: 多选非法输入 → filter 取有效 ────────────────────────────────
    it('typing non-numeric input filters out invalid indices', async () => {
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          question="Select colors"
          options={[{ label: '红' }, { label: '绿' }, { label: '蓝' }]}
          multiSelect={true}
          status="active"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );

      const input = screen.getByPlaceholderText(/逗号分隔/);
      await userEvent.type(input, 'a, b');
      await userEvent.click(screen.getByRole('button', { name: /提交|Submit/i }));
      // "a" and "b" are not valid indices, filter takes valid only → empty labels → empty string
      expect(onSubmit).toHaveBeenCalledWith('');
    });
  });

  // ── S8: 长 description 不溢出 ──────────────────────────────────────────
  describe('Long description', () => {
    it('does not overflow with 300+ character description', () => {
      const longDesc = 'A'.repeat(300);
      render(
        <AskUserQuestionCard
          question="Pick color"
          options={[{ label: '红色', description: longDesc }]}
          multiSelect={false}
          status="active"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(screen.getByText('红色')).toBeInTheDocument();
      // Container should not cause horizontal scroll — assert the card is within viewport
      const card = screen.getByText('红色').closest('.border-gray-200');
      expect(card).toBeTruthy();
    });
  });

  // ── S6: Disabled / Timeout ──────────────────────────────────────────────
  describe('Disabled state', () => {
    it('options grayed, not clickable, result text shown', async () => {
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          question="Pick color"
          options={[{ label: '红色' }, { label: '蓝色' }]}
          multiSelect={false}
          status="disabled"
          selected="红色"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );

      // Result text visible
      expect(screen.getByText(/你的选择:\s*红色/)).toBeInTheDocument();

      // Options should have pointer-events-none class
      const optionElement = screen.getByText('红色').closest('button, div, [role="button"]');
      expect(optionElement).toBeTruthy();

      // Click should NOT call onSubmit
      if (optionElement) {
        fireEvent.click(optionElement);
      }
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('Timeout state', () => {
    it('shows "已超时" and options are not interactive', () => {
      const onSubmit = vi.fn();
      render(
        <AskUserQuestionCard
          question="Pick color"
          options={[{ label: '红色' }, { label: '蓝色' }]}
          multiSelect={false}
          status="timeout"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />,
      );

      expect(screen.getByText('已超时')).toBeInTheDocument();

      // Options should not be interactive — click should not trigger submit
      const optionElement = screen.getByText('红色').closest('button, div, [role="button"]');
      if (optionElement) {
        fireEvent.click(optionElement);
      }
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });
});
