#!/usr/bin/env node
import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { listModels, startModel, stopModel, viewLogs } from "./commands/models.js";
import { listPods, removePodCommand, setupPod, switchActivePod } from "./commands/pods.js";
import { promptModel } from "./commands/prompt.js";
import { getActivePod, loadConfig } from "./config.js";
import { sshExecStream } from "./ssh.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

function printHelp() {
	console.log(`mu-pods v${packageJson.version} - Manage vLLM deployments on GPU pods

Pod Management:
	  mu-pods pods setup <name> "<ssh>" --mount "<mount>"    Setup pod with mount command
	    Options:
	      --vllm release    Install latest vLLM release >=0.10.0 (default)
	      --vllm nightly    Install vLLM nightly build (latest features)
	      --vllm gpt-oss    Install vLLM 0.10.1+gptoss with PyTorch nightly (GPT-OSS only)
	  mu-pods pods                                           List all pods (* = active)
	  mu-pods pods active <name>                             Switch active pod
	  mu-pods pods remove <name>                             Remove pod from local config
	  mu-pods shell [<name>]                                 Open shell on pod (active or specified)
	  mu-pods ssh [<name>] "<command>"                       Run SSH command on pod

Model Management:
	  mu-pods start <model> --name <name> [options]          Start a model
	    --memory <percent>   GPU memory allocation (30%, 50%, 90%)
	    --context <size>     Context window (4k, 8k, 16k, 32k, 64k, 128k)
	    --gpus <count>       Number of GPUs to use (predefined models only)
	    --vllm <args...>     Pass remaining args to vLLM (ignores other options)
	  mu-pods stop [<name>]                                  Stop model (or all if no name)
	  mu-pods list                                           List running models
	  mu-pods logs <name>                                    Stream model logs
	  mu-pods agent <name> ["<message>"...] [options]        Chat with model using agent & tools
	  mu-pods agent <name> [options]                         Interactive chat mode
	    --continue, -c       Continue previous session
	    --json              Output as JSONL
	    (All mu-agent options are supported)

  All model commands support --pod <name> to override the active pod.

Environment:
  HF_TOKEN         HuggingFace token for model downloads
  MU_API_KEY     API key for vLLM endpoints
  MU_CONFIG_DIR    Config directory (default: ~/.mu)`);
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	printHelp();
	process.exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
	console.log(packageJson.version);
	process.exit(0);
}

const command = args[0];
const subcommand = args[1];

// Main command handler
try {
	// Handle "mu pods" commands
	if (command === "pods") {
		if (!subcommand) {
			// mu pods - list all pods
			listPods();
		} else if (subcommand === "setup") {
			// mu pods setup <name> "<ssh>" [--mount "<mount>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]
			const name = args[2];
			const sshCmd = args[3];

			if (!name || !sshCmd) {
				console.error(
					'Usage: mu pods setup <name> "<ssh>" [--mount "<mount>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]',
				);
				process.exit(1);
			}

			// Parse options
			const options: { mount?: string; modelsPath?: string; vllm?: "release" | "nightly" | "gpt-oss" } = {};
			for (let i = 4; i < args.length; i++) {
				if (args[i] === "--mount" && i + 1 < args.length) {
					options.mount = args[i + 1];
					i++;
				} else if (args[i] === "--models-path" && i + 1 < args.length) {
					options.modelsPath = args[i + 1];
					i++;
				} else if (args[i] === "--vllm" && i + 1 < args.length) {
					const vllmType = args[i + 1];
					if (vllmType === "release" || vllmType === "nightly" || vllmType === "gpt-oss") {
						options.vllm = vllmType;
					} else {
						console.error(chalk.red(`Invalid vLLM type: ${vllmType}`));
						console.error("Valid options: release, nightly, gpt-oss");
						process.exit(1);
					}
					i++;
				}
			}

			// If --mount provided but no --models-path, try to extract path from mount command
			if (options.mount && !options.modelsPath) {
				// Extract last part of mount command as models path
				const parts = options.mount.trim().split(" ");
				const lastPart = parts[parts.length - 1];
				if (lastPart?.startsWith("/")) {
					options.modelsPath = lastPart;
				}
			}

			await setupPod(name, sshCmd, options);
		} else if (subcommand === "active") {
			// mu pods active <name>
			const name = args[2];
			if (!name) {
				console.error("Usage: mu pods active <name>");
				process.exit(1);
			}
			switchActivePod(name);
		} else if (subcommand === "remove") {
			// mu pods remove <name>
			const name = args[2];
			if (!name) {
				console.error("Usage: mu pods remove <name>");
				process.exit(1);
			}
			removePodCommand(name);
		} else {
			console.error(`Unknown pods subcommand: ${subcommand}`);
			process.exit(1);
		}
	} else {
		// Parse --pod override for model commands
		let podOverride: string | undefined;
		const podIndex = args.indexOf("--pod");
		if (podIndex !== -1 && podIndex + 1 < args.length) {
			podOverride = args[podIndex + 1];
			// Remove --pod and its value from args
			args.splice(podIndex, 2);
		}

		// Handle SSH/shell commands and model commands
		switch (command) {
			case "shell": {
				// mu shell [<name>] - open interactive shell
				const podName = args[1];
				let podInfo: { name: string; pod: import("./types.js").Pod } | null = null;

				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'mu pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.green(`Connecting to pod '${podInfo.name}'...`));

				// Execute SSH in interactive mode
				const sshArgs = podInfo.pod.ssh.split(" ").slice(1); // Remove 'ssh' from command
				const sshProcess = spawn("ssh", sshArgs, {
					stdio: "inherit",
					env: process.env,
				});

				sshProcess.on("exit", (code) => {
					process.exit(code || 0);
				});
				break;
			}
			case "ssh": {
				// mu ssh [<name>] "<command>" - run command via SSH
				let podName: string | undefined;
				let sshCommand: string;

				if (args.length === 2) {
					// mu ssh "<command>" - use active pod
					sshCommand = args[1];
				} else if (args.length === 3) {
					// mu ssh <name> "<command>"
					podName = args[1];
					sshCommand = args[2];
				} else {
					console.error('Usage: mu ssh [<name>] "<command>"');
					process.exit(1);
				}

				let podInfo: { name: string; pod: import("./types.js").Pod } | null = null;

				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'mu pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.gray(`Running on pod '${podInfo.name}': ${sshCommand}`));

				// Execute command and stream output
				const exitCode = await sshExecStream(podInfo.pod.ssh, sshCommand);
				process.exit(exitCode);
				break;
			}
			case "start": {
				// mu start <model> --name <name> [options]
				const modelId = args[1];
				if (!modelId) {
					// Show available models
					const { showKnownModels } = await import("./commands/models.js");
					await showKnownModels();
					process.exit(0);
				}

				// Parse options
				let name: string | undefined;
				let memory: string | undefined;
				let context: string | undefined;
				let gpus: number | undefined;
				const vllmArgs: string[] = [];
				let inVllmArgs = false;

				for (let i = 2; i < args.length; i++) {
					if (inVllmArgs) {
						vllmArgs.push(args[i]);
					} else if (args[i] === "--name" && i + 1 < args.length) {
						name = args[i + 1];
						i++;
					} else if (args[i] === "--memory" && i + 1 < args.length) {
						memory = args[i + 1];
						i++;
					} else if (args[i] === "--context" && i + 1 < args.length) {
						context = args[i + 1];
						i++;
					} else if (args[i] === "--gpus" && i + 1 < args.length) {
						gpus = parseInt(args[i + 1], 10);
						if (Number.isNaN(gpus) || gpus < 1) {
							console.error(chalk.red("--gpus must be a positive number"));
							process.exit(1);
						}
						i++;
					} else if (args[i] === "--vllm") {
						inVllmArgs = true;
					}
				}

				if (!name) {
					console.error("--name is required");
					process.exit(1);
				}

				// Warn if --vllm is used with other parameters
				if (vllmArgs.length > 0 && (memory || context || gpus)) {
					console.log(
						chalk.yellow("⚠ Warning: --memory, --context, and --gpus are ignored when --vllm is specified"),
					);
					console.log(chalk.yellow("  Using only custom vLLM arguments"));
					console.log("");
				}

				await startModel(modelId, name, {
					pod: podOverride,
					memory,
					context,
					gpus,
					vllmArgs: vllmArgs.length > 0 ? vllmArgs : undefined,
				});
				break;
			}
			case "stop": {
				// mu stop [name] - stop specific model or all models
				const name = args[1];
				if (!name) {
					// Stop all models on the active pod
					const { stopAllModels } = await import("./commands/models.js");
					await stopAllModels({ pod: podOverride });
				} else {
					await stopModel(name, { pod: podOverride });
				}
				break;
			}
			case "list":
				// mu list
				await listModels({ pod: podOverride });
				break;
			case "logs": {
				// mu logs <name>
				const name = args[1];
				if (!name) {
					console.error("Usage: mu logs <name>");
					process.exit(1);
				}
				await viewLogs(name, { pod: podOverride });
				break;
			}
			case "agent": {
				// mu agent <name> [messages...] [options]
				const name = args[1];
				if (!name) {
					console.error("Usage: mu agent <name> [messages...] [options]");
					process.exit(1);
				}

				const apiKey = process.env.MU_API_KEY;

				// Pass all args after the model name
				const agentArgs = args.slice(2);

				// If no messages provided, it's interactive mode
				await promptModel(name, agentArgs, {
					pod: podOverride,
					apiKey,
				}).catch(() => {
					// Error already handled in promptModel, just exit cleanly
					process.exit(0);
				});
				break;
			}
			default:
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exit(1);
		}
	}
} catch (error) {
	console.error("Error:", error);
	process.exit(1);
}
