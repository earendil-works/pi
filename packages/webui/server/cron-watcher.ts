/**
 * CronWatcher - Watches cron.json for changes and notifies subscribers.
 * Used for cross-process sync when cron.json is modified by other processes (TUI, extension, other WebUI instances).
 */

import * as chokidar from "chokidar";

export type CronWatcherEvent = { type: "cron_changed" };

type Listener = (event: CronWatcherEvent) => void;

export class CronWatcher {
  private readonly path: string;
  private watcher: chokidar.FSWatcher | null = null;
  private readonly listeners = new Set<Listener>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs = 200;

  constructor(cronDataPath: string) {
    this.path = cronDataPath;
  }

  /**
   * Start watching the cron.json file for changes.
   */
  start(): void {
    if (this.watcher) {
      return; // already started
    }

    this.watcher = chokidar.watch(this.path, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    this.watcher.on("change", () => this.handleChange());
    this.watcher.on("add", () => this.handleChange());
    // Note: 'unlink' is not handled since cron.json should always exist once created.
    // If deleted, cron-store will recreate it on next add.
  }

  /**
   * Stop watching and release resources.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Subscribe to cron.json change events.
   * @param fn - Listener function called when cron.json changes
   * @returns Unsubscribe function to remove the listener
   */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private handleChange(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const event: CronWatcherEvent = { type: "cron_changed" };
      Array.from(this.listeners).forEach((listener) => listener(event));
    }, this.debounceMs);
  }
}
