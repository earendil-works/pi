import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import * as React from 'react';
import { AppShell } from './AppShell';
import type { SessionInfo } from '../lib/api';

const mockSessions: SessionInfo[] = [
  {
    id: '1',
    title: 'Test Session 1',
    status: 'idle',
    lastActive: '2024-01-01T00:00:00Z',
    messageCount: 5,
  },
  {
    id: '2',
    title: 'Test Session 2',
    status: 'running',
    lastActive: '2024-01-02T00:00:00Z',
    messageCount: 10,
  },
];

describe('AppShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Brand component with version', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={[]}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    expect(screen.getByText('pi')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
  });

  it('renders IconRow component', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={[]}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    // IconRow should render icon buttons for navigation
    const chatIcon = document.querySelector('[aria-label="Chat"]');
    expect(chatIcon).toBeInTheDocument();
  });

  it('renders SearchBox component', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={mockSessions}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    const searchInput = screen.getByPlaceholderText('Filter conversations...');
    expect(searchInput).toBeInTheDocument();
  });

  it('renders ConversationList with sessions', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={mockSessions}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    expect(screen.getByText('Test Session 1')).toBeInTheDocument();
    expect(screen.getByText('Test Session 2')).toBeInTheDocument();
  });

  it('renders NewChatButton component', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={[]}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    expect(screen.getByText('New conversation')).toBeInTheDocument();
  });

  it('renders children content', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={[]}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div data-testid="children-content">Main Content</div>
      </AppShell>
    );
    expect(screen.getByTestId('children-content')).toBeInTheDocument();
  });

  it('triggers onNewChat when NewChatButton is clicked', () => {
    const onNewChat = vi.fn();
    render(
      <AppShell
        version="1.0.0"
        sessions={[]}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={onNewChat}
      >
        <div>Main Content</div>
      </AppShell>
    );
    fireEvent.click(screen.getByText('New conversation'));
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it('triggers onFilterChange when SearchBox input changes', () => {
    const onFilterChange = vi.fn();
    render(
      <AppShell
        version="1.0.0"
        sessions={mockSessions}
        filterQuery=""
        onFilterChange={onFilterChange}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    const searchInput = screen.getByPlaceholderText('Filter conversations...');
    fireEvent.change(searchInput, { target: { value: 'test' } });
    expect(onFilterChange).toHaveBeenCalledWith('test');
  });

  it('triggers onSelectSession when a session is clicked', () => {
    const onSelectSession = vi.fn();
    render(
      <AppShell
        version="1.0.0"
        sessions={mockSessions}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={onSelectSession}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    fireEvent.click(screen.getByText('Test Session 1'));
    expect(onSelectSession).toHaveBeenCalledWith('1');
  });

  it('shows loading state on NewChatButton when isCreatingChat is true', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={[]}
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
        isCreatingChat={true}
      >
        <div>Main Content</div>
      </AppShell>
    );
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeDisabled();
  });

  it('filters sessions based on filterQuery', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={mockSessions}
        filterQuery="Session 1"
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    expect(screen.getByText('Test Session 1')).toBeInTheDocument();
    expect(screen.queryByText('Test Session 2')).not.toBeInTheDocument();
  });

  it('highlights current session', () => {
    render(
      <AppShell
        version="1.0.0"
        sessions={mockSessions}
        currentSessionId="1"
        filterQuery=""
        onFilterChange={vi.fn()}
        onSelectSession={vi.fn()}
        onDeleteSession={vi.fn()}
        onNewChat={vi.fn()}
      >
        <div>Main Content</div>
      </AppShell>
    );
    const session1 = screen.getByText('Test Session 1').closest('div');
    expect(session1?.className).toContain('bg-blue-100');
  });
});
