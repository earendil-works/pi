// ── REAL facet code. Nothing here knows it is sandboxed. ────────────────────
// No imports rewritten, no string marshalling, no __dispatch. It uses the
// host API exactly as facets.md §11.1 describes it.

class FooterComponent {
  constructor(props) { this.label = props.label; this.count = 0; }
  render(width) {
    const text = ` ${this.label}: ${this.count} `;
    const pad = Math.max(0, width - text.length - 2);
    const bar = "\u2500".repeat(Math.max(0, width - 2));
    return [`\u250c${bar}\u2510`, `\u2502${text}${" ".repeat(pad)}\u2502`, `\u2514${bar}\u2518`];
  }
  handleInput(data) { this.count += data.length; }
}

const facet = {
  id: "@demo/footer:tui",
  uses: ["Tui", "Transcript"],

  construct(ctx) {
    const tui = ctx.use("Tui");
    const transcript = ctx.use("Transcript");

    // A factory crossing guest → host, by reference.
    tui.slots.claim("footer", (props) => new FooterComponent(props));

    // A command handler, likewise.
    tui.commands.add("footer.reset", () => {
      tui.notify("footer reset");
      return "ok";
    });

    // A subscription: host calls back into the guest.
    transcript.tail.subscribe((tail) => {
      tui.notify(`transcript now has ${tail.entries.length} entries`);
    });

    return [];
  },
};

globalThis.__facet = facet;
