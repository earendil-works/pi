import { describe, it, expect } from "bun:test";
import { detectIntent } from "./satellite-server.ts";

describe("detectIntent", () => {
  // S2: 层 B — bash cat 引导到 read_file
  it("a: cat /foo/x.txt → read_file", () => {
    expect(detectIntent("cat /foo/x.txt")).toBe("read_file");
  });

  // S3: 层 B — bash sed -i 引导到 edit_file
  it("b: sed -i 's/a/b/' /foo/x → edit_file", () => {
    expect(detectIntent("sed -i 's/a/b/' /foo/x")).toBe("edit_file");
  });

  // S4: 层 B — bash echo > 引导到 write_file
  it("c: echo 'x' > /foo/y → write_file", () => {
    expect(detectIntent("echo 'x' > /foo/y")).toBe("write_file");
  });

  // S4: 层 B — bash printf > 引导到 write_file (c2 variant)
  it("c2: printf 'x' > /foo/y → write_file", () => {
    expect(detectIntent("printf 'x' > /foo/y")).toBe("write_file");
  });

  // S5: 层 B — bash find 引导到 find_files
  it("d: find /foo -name '*.ts' → find_files", () => {
    expect(detectIntent("find /foo -name '*.ts'")).toBe("find_files");
  });

  // S6: 层 B — bash grep -r 引导到 grep_files
  it("e: grep -r foo /bar → grep_files", () => {
    expect(detectIntent("grep -r foo /bar")).toBe("grep_files");
  });

  // S6: 层 B — 合法 bash 命令正常通过 (ls -la)
  it("f: ls -la /foo → null (legitimate bash)", () => {
    expect(detectIntent("ls -la /foo")).toBe(null);
  });

  // S6: 层 B — 合法 bash 命令正常通过 (pipeline)
  it("g: cat file1 file2 | grep x → null (pipeline)", () => {
    expect(detectIntent("cat file1 file2 | grep x")).toBe(null);
  });

  // S6: 层 B — 合法 bash 命令正常通过 (stdin redirect)
  it("h: cat < input.txt → null (stdin redirect)", () => {
    expect(detectIntent("cat < input.txt")).toBe(null);
  });
});
