# Changelog

## [Unreleased]

## [0.66.2] - 2026-04-11

### Added

- `secureMode` setting (enabled by default) for closed-network deployments: restricts LLM API calls to providers that have an explicit `baseUrl` configured in `models.json`, blocking built-in providers from reaching commercial cloud endpoints unless redirected to internal infrastructure. Disable by setting `"secureMode": false` in `settings.json`.

### Changed

- CLI command renamed from `pi` to `spi`.
- Config directory renamed from `.pi/` to `.spi/`.
- Environment variables renamed: `PI_CODING_AGENT_DIR` → `SPI_CODING_AGENT_DIR`, `PI_OFFLINE` → `SPI_OFFLINE`, `PI_PACKAGE_DIR` → `SPI_PACKAGE_DIR`, `PI_SHARE_VIEWER_URL` → `SPI_SHARE_VIEWER_URL`.
- npm package renamed from `@mariozechner/pi-coding-agent` to `@tculpepp/spi-coding-agent`.
- Extension and package manifests now use the `spi` key (e.g. `"spi": { ... }` in `package.json`). The legacy `pi` key is still accepted for compatibility with upstream packages.

### Fixed

- Extension loader no longer hardcodes `.pi/extensions` as the local extension directory; it now correctly respects the configured `CONFIG_DIR_NAME` (`.spi/`).

## [0.66.1] - 2026-04-08

> Forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono) at this version.
> See the [upstream changelog](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md) for prior history.
