/**
 * Space Invaders game extension - play with /invaders command
 * Uses Kitty keyboard protocol for smooth movement (press/release detection)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

const GAME_WIDTH = 60;
const GAME_HEIGHT = 24;
const TICK_MS = 50;
const PLAYER_Y = GAME_HEIGHT - 2;
const ALIEN_ROWS = 5;
const ALIEN_COLS = 11;
const ALIEN_START_Y = 2;

type Point = { x: number; y: number };

interface Bullet extends Point {
	direction: -1 | 1; // -1 = up (player), 1 = down (alien)
}

interface Alien extends Point {
	type: number; // 0, 1, 2 for different alien types
	alive: boolean;
}

interface Shield {
	x: number;
	segments: boolean[][]; // 4x3 grid of destructible segments
}

interface GameState {
	player: { x: number; lives: number };
	aliens: Alien[];
	alienDirection: 1 | -1;
	alienMoveCounter: number;
	alienMoveDelay: number;
	alienDropping: boolean;
	bullets: Bullet[];
	shields: Shield[];
	score: number;
	highScore: number;
	level: number;
	gameOver: boolean;
	victory: boolean;
	alienShootCounter: number;
}

interface KeyState {
	left: boolean;
	right: boolean;
	fire: boolean;
}

function createShields(): Shield[] {
	const shields: Shield[] = [];
	const shieldPositions = [8, 22, 36, 50];
	for (const x of shieldPositions) {
		shields.push({
			x,
			segments: [
				[true, true, true, true],
				[true, true, true, true],
				[true, false, false, true],
			],
		});
	}
	return shields;
}

function createAliens(): Alien[] {
	const aliens: Alien[] = [];
	for (let row = 0; row < ALIEN_ROWS; row++) {
		const type = row === 0 ? 2 : row < 3 ? 1 : 0;
		for (let col = 0; col < ALIEN_COLS; col++) {
			aliens.push({
				x: 4 + col * 5,
				y: ALIEN_START_Y + row * 2,
				type,
				alive: true,
			});
		}
	}
	return aliens;
}

function createInitialState(highScore = 0, level = 1): GameState {
	return {
		player: { x: Math.floor(GAME_WIDTH / 2), lives: 3 },
		aliens: createAliens(),
		alienDirection: 1,
		alienMoveCounter: 0,
		alienMoveDelay: Math.max(5, 20 - level * 2),
		alienDropping: false,
		bullets: [],
		shields: createShields(),
		score: 0,
		highScore,
		level,
		gameOver: false,
		victory: false,
		alienShootCounter: 0,
	};
}

class SpaceInvadersComponent {
	private state: GameState;
	private keys: KeyState = { left: false, right: false, fire: false };
	private interval: ReturnType<typeof setInterval> | null = null;
	private onClose: () => void;
	private onSave: (state: GameState | null) => void;
	private tui: { requestRender: () => void };
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private version = 0;
	private cachedVersion = -1;
	private paused: boolean;
	private fireCooldown = 0;
	private playerMoveCounter = 0;

	// Opt-in to key release events for smooth movement
	wantsKeyRelease = true;

	constructor(
		tui: { requestRender: () => void },
		onClose: () => void,
		onSave: (state: GameState | null) => void,
		savedState?: GameState,
	) {
		this.tui = tui;
		if (savedState && !savedState.gameOver && !savedState.victory) {
			this.state = savedState;
			this.paused = true;
		} else {
			this.state = createInitialState(savedState?.highScore);
			this.paused = false;
			this.startGame();
		}
		this.onClose = onClose;
		this.onSave = onSave;
	}

	private startGame(): void {
		this.interval = setInterval(() => {
			if (!this.state.gameOver && !this.state.victory) {
				this.tick();
				this.version++;
				this.tui.requestRender();
			}
		}, TICK_MS);
	}

	private tick(): void {
		// Player movement (smooth, every other tick)
		this.playerMoveCounter++;
		if (this.playerMoveCounter >= 2) {
			this.playerMoveCounter = 0;
			if (this.keys.left && this.state.player.x > 2) {
				this.state.player.x--;
			}
			if (this.keys.right && this.state.player.x < GAME_WIDTH - 3) {
				this.state.player.x++;
			}
		}

		// Fire cooldown
		if (this.fireCooldown > 0) this.fireCooldown--;

		// Player shooting
		if (this.keys.fire && this.fireCooldown === 0) {
			const playerBullets = this.state.bullets.filter((b) => b.direction === -1);
			if (playerBullets.length < 2) {
				this.state.bullets.push({ x: this.state.player.x, y: PLAYER_Y - 1, direction: -1 });
				this.fireCooldown = 8;
			}
		}

		// Move bullets
		this.state.bullets = this.state.bullets.filter((bullet) => {
			bullet.y += bullet.direction;
			return bullet.y >= 0 && bullet.y < GAME_HEIGHT;
		});

		// Alien movement
		this.state.alienMoveCounter++;
		if (this.state.alienMoveCounter >= this.state.alienMoveDelay) {
			this.state.alienMoveCounter = 0;
			this.moveAliens();
		}

		// Alien shooting
		this.state.alienShootCounter++;
		if (this.state.alienShootCounter >= 30) {
			this.state.alienShootCounter = 0;
			this.alienShoot();
		}

		// Collision detection
		this.checkCollisions();

		// Check victory
		if (this.state.aliens.every((a) => !a.alive)) {
			this.state.victory = true;
		}
	}

	private moveAliens(): void {
		const aliveAliens = this.state.aliens.filter((a) => a.alive);
		if (aliveAliens.length === 0) return;

		if (this.state.alienDropping) {
			// Drop down
			for (const alien of aliveAliens) {
				alien.y++;
				if (alien.y >= PLAYER_Y - 1) {
					this.state.gameOver = true;
					return;
				}
			}
			this.state.alienDropping = false;
		} else {
			// Check if we need to change direction
			const minX = Math.min(...aliveAliens.map((a) => a.x));
			const maxX = Math.max(...aliveAliens.map((a) => a.x));

			if (
				(this.state.alienDirection === 1 && maxX >= GAME_WIDTH - 3) ||
				(this.state.alienDirection === -1 && minX <= 2)
			) {
				this.state.alienDirection *= -1;
				this.state.alienDropping = true;
			} else {
				// Move horizontally
				for (const alien of aliveAliens) {
					alien.x += this.state.alienDirection;
				}
			}
		}

		// Speed up as fewer aliens remain
		const aliveCount = aliveAliens.length;
		if (aliveCount <= 5) {
			this.state.alienMoveDelay = 1;
		} else if (aliveCount <= 10) {
			this.state.alienMoveDelay = 2;
		} else if (aliveCount <= 20) {
			this.state.alienMoveDelay = 3;
		}
	}

	private alienShoot(): void {
		const aliveAliens = this.state.aliens.filter((a) => a.alive);
		if (aliveAliens.length === 0) return;

		// Find bottom-most alien in each column
		const columns = new Map<number, Alien>();
		for (const alien of aliveAliens) {
			const existing = columns.get(alien.x);
			if (!existing || alien.y > existing.y) {
				columns.set(alien.x, alien);
			}
		}

		// Random column shoots
		const shooters = Array.from(columns.values());
		if (shooters.length > 0 && this.state.bullets.filter((b) => b.direction === 1).length < 3) {
			const shooter = shooters[Math.floor(Math.random() * shooters.length)];
			this.state.bullets.push({ x: shooter.x, y: shooter.y + 1, direction: 1 });
		}
	}

	private checkCollisions(): void {
		const bulletsToRemove = new Set<Bullet>();

		for (const bullet of this.state.bullets) {
			// Player bullets hitting aliens
			if (bullet.direction === -1) {
				for (const alien of this.state.aliens) {
					if (alien.alive && Math.abs(bullet.x - alien.x) <= 1 && bullet.y === alien.y) {
						alien.alive = false;
						bulletsToRemove.add(bullet);
						const points = [10, 20, 30][alien.type];
						this.state.score += points;
						if (this.state.score > this.state.highScore) {
							this.state.highScore = this.state.score;
						}
						break;
					}
				}
			}

			// Alien bullets hitting player
			if (bullet.direction === 1) {
				if (Math.abs(bullet.x - this.state.player.x) <= 1 && bullet.y === PLAYER_Y) {
					bulletsToRemove.add(bullet);
					this.state.player.lives--;
					if (this.state.player.lives <= 0) {
						this.state.gameOver = true;
					}
				}
			}

			// Bullets hitting shields
			for (const shield of this.state.shields) {
				const relX = bullet.x - shield.x;
				const relY = bullet.y - (PLAYER_Y - 5);
				if (relX >= 0 && relX < 4 && relY >= 0 && relY < 3) {
					if (shield.segments[relY][relX]) {
						shield.segments[relY][relX] = false;
						bulletsToRemove.add(bullet);
					}
				}
			}
		}

		this.state.bullets = this.state.bullets.filter((b) => !bulletsToRemove.has(b));
	}

	handleInput(data: string): void {
		const released = isKeyRelease(data);

		// Pause handling
		if (this.paused && !released) {
			if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
				this.dispose();
				this.onClose();
				return;
			}
			this.paused = false;
			this.startGame();
			return;
		}

		// ESC to pause and save
		if (!released && matchesKey(data, Key.escape)) {
			this.dispose();
			this.onSave(this.state);
			this.onClose();
			return;
		}

		// Q to quit without saving
		if (!released && (data === "q" || data === "Q")) {
			this.dispose();
			this.onSave(null);
			this.onClose();
			return;
		}

		// Movement keys (track press/release state)
		if (matchesKey(data, Key.left) || data === "a" || data === "A" || matchesKey(data, "a")) {
			this.keys.left = !released;
		}
		if (matchesKey(data, Key.right) || data === "d" || data === "D" || matchesKey(data, "d")) {
			this.keys.right = !released;
		}

		// Fire key
		if (matchesKey(data, Key.space) || data === " " || data === "f" || data === "F" || matchesKey(data, "f")) {
			this.keys.fire = !released;
		}

		// Restart on game over or victory
		if (!released && (this.state.gameOver || this.state.victory)) {
			if (data === "r" || data === "R" || data === " ") {
				const highScore = this.state.highScore;
				const nextLevel = this.state.victory ? this.state.level + 1 : 1;
				this.state = createInitialState(highScore, nextLevel);
				this.keys = { left: false, right: false, fire: false };
				this.onSave(null);
				this.version++;
				this.tui.requestRender();
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedVersion === this.version) {
			return this.cachedLines;
		}

		const lines: string[] = [];

		// Colors
		const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
		const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
		const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
		const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
		const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
		const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
		const white = (s: string) => `\x1b[97m${s}\x1b[0m`;
		const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;

		const boxWidth = GAME_WIDTH;

		const boxLine = (content: string) => {
			const contentLen = visibleWidth(content);
			const padding = Math.max(0, boxWidth - contentLen);
			return dim(" │") + content + " ".repeat(padding) + dim("│");
		};

		// Top border
		lines.push(this.padLine(dim(` ╭${"─".repeat(boxWidth)}╮`), width));

		// Header
		const title = `${bold(green("SPACE INVADERS"))}`;
		const scoreText = `Score: ${bold(yellow(String(this.state.score)))}`;
		const highText = `Hi: ${bold(yellow(String(this.state.highScore)))}`;
		const levelText = `Lv: ${bold(cyan(String(this.state.level)))}`;
		const livesText = `${red("♥".repeat(this.state.player.lives))}`;
		const header = `${title} │ ${scoreText} │ ${highText} │ ${levelText} │ ${livesText}`;
		lines.push(this.padLine(boxLine(header), width));

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Game grid
		for (let y = 0; y < GAME_HEIGHT; y++) {
			let row = "";
			for (let x = 0; x < GAME_WIDTH; x++) {
				let char = " ";
				let colored = false;

				// Check aliens
				for (const alien of this.state.aliens) {
					if (alien.alive && alien.y === y && Math.abs(alien.x - x) <= 1) {
						const sprites = [
							x === alien.x ? "▼" : "╲╱"[x < alien.x ? 0 : 1],
							x === alien.x ? "◆" : "╱╲"[x < alien.x ? 0 : 1],
							x === alien.x ? "☆" : "◄►"[x < alien.x ? 0 : 1],
						];
						const colors = [green, cyan, magenta];
						char = colors[alien.type](sprites[alien.type]);
						colored = true;
						break;
					}
				}

				// Check shields
				if (!colored) {
					for (const shield of this.state.shields) {
						const relX = x - shield.x;
						const relY = y - (PLAYER_Y - 5);
						if (relX >= 0 && relX < 4 && relY >= 0 && relY < 3) {
							if (shield.segments[relY][relX]) {
								char = dim("█");
								colored = true;
							}
							break;
						}
					}
				}

				// Check player
				if (!colored && y === PLAYER_Y && Math.abs(x - this.state.player.x) <= 1) {
					if (x === this.state.player.x) {
						char = white("▲");
					} else {
						char = white("═");
					}
					colored = true;
				}

				// Check bullets
				if (!colored) {
					for (const bullet of this.state.bullets) {
						if (bullet.x === x && bullet.y === y) {
							char = bullet.direction === -1 ? yellow("│") : red("│");
							colored = true;
							break;
						}
					}
				}

				row += colored ? char : " ";
			}
			lines.push(this.padLine(dim(" │") + row + dim("│"), width));
		}

		// Separator
		lines.push(this.padLine(dim(` ├${"─".repeat(boxWidth)}┤`), width));

		// Footer
		let footer: string;
		if (this.paused) {
			footer = `${yellow(bold("PAUSED"))} Press any key to continue, ${bold("Q")} to quit`;
		} else if (this.state.gameOver) {
			footer = `${red(bold("GAME OVER!"))} Press ${bold("R")} to restart, ${bold("Q")} to quit`;
		} else if (this.state.victory) {
			footer = `${green(bold("VICTORY!"))} Press ${bold("R")} for level ${this.state.level + 1}, ${bold("Q")} to quit`;
		} else {
			footer = `←→ or AD to move, ${bold("SPACE")}/F to fire, ${bold("ESC")} pause, ${bold("Q")} quit`;
		}
		lines.push(this.padLine(boxLine(footer), width));

		// Bottom border
		lines.push(this.padLine(dim(` ╰${"─".repeat(boxWidth)}╯`), width));

		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = this.version;

		return lines;
	}

	private padLine(line: string, width: number): string {
		const visibleLen = line.replace(/\x1b\[[0-9;]*m/g, "").length;
		const padding = Math.max(0, width - visibleLen);
		return line + " ".repeat(padding);
	}

	dispose(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}

const INVADERS_SAVE_TYPE = "space-invaders-save";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("invaders", {
		description: "Play Space Invaders!",

		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Space Invaders requires interactive mode", "error");
				return;
			}

			// Load saved state from session
			const entries = ctx.sessionManager.getEntries();
			let savedState: GameState | undefined;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry.type === "custom" && entry.customType === INVADERS_SAVE_TYPE) {
					savedState = entry.data as GameState;
					break;
				}
			}

			await ctx.ui.custom((tui, _theme, _kb, done) => {
				return new SpaceInvadersComponent(
					tui,
					() => done(undefined),
					(state) => {
						pi.appendEntry(INVADERS_SAVE_TYPE, state);
					},
					savedState,
				);
			});
		},
	});
}
