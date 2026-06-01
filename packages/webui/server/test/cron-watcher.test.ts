import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CronWatcher } from "../cron-watcher";

describe("CronWatcher", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-watcher-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, "[]");
  });

  afterEach(() => {
    fs.rmSync(tmpFile, { force: true });
  });

  it("emits cron_changed when the file is modified", async () => {
    const watcher = new CronWatcher(tmpFile);
    const events: any[] = [];
    watcher.subscribe((e) => events.push(e));
    watcher.start();

    // Wait a bit for chokidar to initialize
    await new Promise((r) => setTimeout(r, 100));

    // Modify the file
    fs.writeFileSync(tmpFile, '[{"id":"x"}]');

    // Wait for debounce + chokidar detection
    await new Promise((r) => setTimeout(r, 600));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("cron_changed");

    watcher.stop();
  });

  it("multiple subscribers all receive events", async () => {
    const watcher = new CronWatcher(tmpFile);
    const events1: any[] = [];
    const events2: any[] = [];
    const unsub1 = watcher.subscribe((e) => events1.push(e));
    const unsub2 = watcher.subscribe((e) => events2.push(e));
    watcher.start();

    await new Promise((r) => setTimeout(r, 100));

    fs.writeFileSync(tmpFile, '[{"id":"y"}]');

    await new Promise((r) => setTimeout(r, 600));

    expect(events1.length).toBeGreaterThanOrEqual(1);
    expect(events2.length).toBeGreaterThanOrEqual(1);
    expect(events1[0].type).toBe("cron_changed");
    expect(events2[0].type).toBe("cron_changed");

    unsub1();
    unsub2();
    watcher.stop();
  });

  it("unsubscribe removes listener", async () => {
    const watcher = new CronWatcher(tmpFile);
    const events: any[] = [];
    const unsub = watcher.subscribe((e) => events.push(e));
    watcher.start();

    await new Promise((r) => setTimeout(r, 100));

    unsub(); // unsubscribe before file change

    fs.writeFileSync(tmpFile, '[{"id":"z"}]');

    await new Promise((r) => setTimeout(r, 600));

    expect(events.length).toBe(0);

    watcher.stop();
  });

  it("stop closes the watcher", async () => {
    const watcher = new CronWatcher(tmpFile);
    const events: any[] = [];
    watcher.subscribe((e) => events.push(e));
    watcher.start();
    watcher.stop();

    // After stop, file changes should not emit events
    fs.writeFileSync(tmpFile, '[{"id":"a"}]');

    await new Promise((r) => setTimeout(r, 600));

    expect(events.length).toBe(0);
  });

  it("does not emit on initial file presence", async () => {
    const watcher = new CronWatcher(tmpFile);
    const events: any[] = [];
    watcher.subscribe((e) => events.push(e));

    // Start watcher after file already exists
    await new Promise((r) => setTimeout(r, 50));
    watcher.start();

    // Wait longer than debounce
    await new Promise((r) => setTimeout(r, 400));

    // Should not emit for existing file due to ignoreInitial
    expect(events.length).toBe(0);

    watcher.stop();
  });
});
