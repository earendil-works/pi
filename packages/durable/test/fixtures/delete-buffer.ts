// Preloaded before the measured module graph so modules observe a browser-like global without Node's Buffer.
Reflect.deleteProperty(globalThis, "Buffer");
