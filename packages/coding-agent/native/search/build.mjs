// Build the Rust Node-API addon without npm install-time scripts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, globSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const targets = {
  'aarch64-apple-darwin': ['darwin-arm64', 'libpi_search.dylib'],
  'x86_64-apple-darwin': ['darwin-x64', 'libpi_search.dylib'],
  'aarch64-unknown-linux-gnu': ['linux-arm64', 'libpi_search.so'],
  'x86_64-unknown-linux-gnu': ['linux-x64', 'libpi_search.so'],
  'aarch64-unknown-linux-musl': ['linux-arm64-musl', 'libpi_search.so'],
  'x86_64-unknown-linux-musl': ['linux-x64-musl', 'libpi_search.so'],
  'aarch64-pc-windows-msvc': ['win32-arm64', 'pi_search.dll'],
  'x86_64-pc-windows-msvc': ['win32-x64', 'pi_search.dll'],
  'aarch64-linux-android': ['android-arm64', 'libpi_search.so'],
  'x86_64-linux-android': ['android-x64', 'libpi_search.so'],
};
const runtime = `${process.platform}-${process.arch}${process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime ? '-musl' : ''}`;
const target = process.argv[2] ?? Object.entries(targets).find(([, [name]]) => name === runtime)?.[0];
const platform = targets[target];
if (!platform) throw new Error(`Unsupported native search target: ${target}`);
const destination = join(root, 'prebuilds', platform[0]);
const hash = createHash('sha256');
for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs', 'build.mjs', ...globSync('src/**/*.rs', { cwd: root }).sort()]) {
  hash.update(file).update('\0').update(readFileSync(join(root, file)));
}
const fingerprint = hash.digest('hex');
const fingerprintPath = join(destination, 'pi-search.sha256');
if (existsSync(join(destination, 'pi-search.node')) && existsSync(fingerprintPath) && readFileSync(fingerprintPath, 'utf8') === fingerprint) {
  console.log(`Using native search prebuild: ${platform[0]}`);
  process.exit(0);
}
const env = { ...process.env, PCRE2_SYS_STATIC: '1' };
if (target.includes('musl')) env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C target-feature=-crt-static`.trim();
// Own the build cache path so Cargo environment/config overrides cannot redirect the artifact copy.
const targetDirectory = join(root, 'target');
const result = spawnSync('cargo', ['build', '--manifest-path', join(root, 'Cargo.toml'), '--release', '--locked', '--target', target, '--target-dir', targetDirectory], { stdio: 'inherit', env });
if (result.error) throw new Error('Building native search from source requires Rust (cargo) and a C compiler', { cause: result.error });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(destination, { recursive: true });
const temporaryAddon = join(destination, `pi-search.${process.pid}.node.tmp`);
try {
  // Replacing the inode avoids stale macOS code-signature caches after a native rebuild.
  copyFileSync(join(targetDirectory, target, 'release', platform[1]), temporaryAddon);
  renameSync(temporaryAddon, join(destination, 'pi-search.node'));
} finally {
  rmSync(temporaryAddon, { force: true });
}
writeFileSync(fingerprintPath, fingerprint);
console.log(`Built native search: ${platform[0]}`);
