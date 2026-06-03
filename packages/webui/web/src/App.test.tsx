/// <reference types="vitest/globals" />
import { describe, it, vi, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SessionInfo } from './lib/api';

// Store captured subscribe handlers per test
let capturedHandlers: Map<string, (msg: unknown) => void> = new Map();

function clearCapturedHandlers() {
  capturedHandlers.clear();
}

const mockSessions: SessionInfo[] = [
  {
    id: 'session-1',
    title: 'Test Session 1',
    status: 'idle',
    lastActive: '2024-01-01T00:00:00Z',
    messageCount: 5,
  },
  {
    id: 'session-2',
    title: 'Test Session 2',
    status: 'running',
    lastActive: '2024-01-02T00:00:00Z',
    messageCount: 10,
  },
];

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearCapturedHandlers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders AppShell with sessions list', async () => {
    vi.doMock('./lib/api', () => ({
      api: {
        listSessions: vi.fn().mockResolvedValue(mockSessions),
        createSession: vi.fn().mockResolvedValue({ id: 'new-session', title: '', status: 'idle', lastActive: '', messageCount: 0 }),
        deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
      },
      ws: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        send: vi.fn(),
        subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
          capturedHandlers.set(type, handler);
          return () => capturedHandlers.delete(type);
        }),
      },
    }));

    const { default: App } = await import('./App');

    // App provides its own BrowserRouter, so render directly
    render(<App />);

    await waitFor(() => {
      // AppShell Brand should show version
      expect(screen.queryByText(/0\.1\.0/)).toBeTruthy();
    });

    // Sessions should be displayed
    expect(screen.queryByText('Test Session 1')).toBeTruthy();
    expect(screen.queryByText('Test Session 2')).toBeTruthy();
  });

  it('loads sessions on mount', async () => {
    const mockListSessions = vi.fn().mockResolvedValue([]);
    vi.doMock('./lib/api', () => ({
      api: {
        listSessions: mockListSessions,
        createSession: vi.fn().mockResolvedValue({ id: 'new-session', title: '', status: 'idle', lastActive: '', messageCount: 0 }),
        deleteSession: vi.fn().mockResolvedValue({ ok: true, atomsExtracted: 0 }),
      },
      ws: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        send: vi.fn(),
        subscribe: vi.fn((type: string, handler: (msg: unknown) => void) => {
          capturedHandlers.set(type, handler);
          return () => capturedHandlers.delete(type);
        }),
      },
    }));

    const { default: App } = await import('./App');

    render(<App />);

    await waitFor(() => {
      expect(mockListSessions).toHaveBeenCalledTimes(1);
    });
  });
});
