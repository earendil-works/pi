import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getActivePod, loadConfig, saveConfig } from "../config.js";
import { getModelConfig, getModelName, isKnownModel } from "../model-configs.js";
import { sshExec } from "../ssh.js";
import type { Pod } from "../types.js";

/**
 * Get the pod to use (active or override)
 */
const getPod = (podOverride?: string): { name: string; pod: Pod } => {
	if (podOverride) {
		const config = loadConfig();
		const pod = config.pods[podOverride];
		if (!pod) {
			console.error(chalk.red(`Pod '${podOverride}' not found`));
			process.exit(1);
		}
		return { name: podOverride, pod };
	}

	const active = getActivePod();
	if (!active) {
		console.error(chalk.red("No active pod. Use 'mu pods active <name>' to set one."));
		process.exit(1);
	}
	return active;
};

/**
 * Find next available port starting from 8001
 */
const getNextPort = (pod: Pod): number => {
	const usedPorts = Object.values(pod.models).map((m) => m.port);
	let port = 8001;
	while (usedPorts.includes(port)) {
		port++;
	}
	return port;
};

/**
 * Select GPUs for model deployment (round-robin)
 */
const selectGPUs = (pod: Pod, count: number = 1): number[] => {
	if (count === pod.gpus.length) {
		// Use all GPUs
		return pod.gpus.map((g) => g.id);
	}

	// Count GPU usage across all models
	const gpuUsage = new Map<number, number>();
	for (const gpu of pod.gpus) {
		gpuUsage.set(gpu.id, 0);
	}

	for (const model of Object.values(pod.models)) {
		for (const gpuId of model.gpu) {
			gpuUsage.set(gpuId, (gpuUsage.get(gpuId) || 0) + 1);
		}
	}

	// Sort GPUs by usage (least used first)
	const sortedGPUs = Array.from(gpuUsage.entries())
		.sort((a, b) => a[1] - b[1])
		.map((entry) => entry[0]);

	// Return the least used GPUs
	return sortedGPUs.slice(0, count);
};

/**
 * Start a model
 */
export const startModel = async (
	modelId: string,
	name: string,
	options: {
		pod?: string;
		vllmArgs?: string[];
		memory?: string;
		context?: string;
		gpus?: number;
	},
) => {
	const { name: podName, pod } = getPod(options.pod);

	// Validation
	if (!pod.modelsPath) {
		console.error(chalk.red("Pod does not have a models path configured"));
		process.exit(1);
	}
	if (pod.models[name]) {
		console.error(chalk.red(`Model '${name}' already exists on pod '${podName}'`));
		process.exit(1);
	}

	const port = getNextPort(pod);

	// Determine GPU allocation and vLLM args
	let gpus: number[] = [];
	let vllmArgs: string[] = [];
	let modelConfig = null;

	if (options.vllmArgs?.length) {
		// Custom args override everything
		vllmArgs = options.vllmArgs;
		console.log(chalk.gray("Using custom vLLM args, GPU allocation managed by vLLM"));
	} else if (isKnownModel(modelId)) {
		// Handle --gpus parameter for known models
		if (options.gpus) {
			// Validate GPU count
			if (options.gpus > pod.gpus.length) {
				console.error(chalk.red(`Error: Requested ${options.gpus} GPUs but pod only has ${pod.gpus.length}`));
				process.exit(1);
			}

			// Try to find config for requested GPU count
			modelConfig = getModelConfig(modelId, pod.gpus, options.gpus);
			if (modelConfig) {
				gpus = selectGPUs(pod, options.gpus);
				vllmArgs = [...(modelConfig.args || [])];
			} else {
				console.error(
					chalk.red(`Model '${getModelName(modelId)}' does not have a configuration for ${options.gpus} GPU(s)`),
				);
				console.error(chalk.yellow("Available configurations:"));

				// Show available configurations
				for (let gpuCount = 1; gpuCount <= pod.gpus.length; gpuCount++) {
					const config = getModelConfig(modelId, pod.gpus, gpuCount);
					if (config) {
						console.error(chalk.gray(`  - ${gpuCount} GPU(s)`));
					}
				}
				process.exit(1);
			}
		} else {
			// Find best config for this hardware (original behavior)
			for (let gpuCount = pod.gpus.length; gpuCount >= 1; gpuCount--) {
				modelConfig = getModelConfig(modelId, pod.gpus, gpuCount);
				if (modelConfig) {
					gpus = selectGPUs(pod, gpuCount);
					vllmArgs = [...(modelConfig.args || [])];
					break;
				}
			}
			if (!modelConfig) {
				console.error(chalk.red(`Model '${getModelName(modelId)}' not compatible with this pod's GPUs`));
				process.exit(1);
			}
		}
	} else {
		// Unknown model
		if (options.gpus) {
			console.error(chalk.red("Error: --gpus can only be used with predefined models"));
			console.error(chalk.yellow("For custom models, use --vllm with tensor-parallel-size or similar arguments"));
			process.exit(1);
		}
		// Single GPU default
		gpus = selectGPUs(pod, 1);
		console.log(chalk.gray("Unknown model, defaulting to single GPU"));
	}

	// Apply memory/context overrides
	if (!options.vllmArgs?.length) {
		if (options.memory) {
			const fraction = parseFloat(options.memory.replace("%", "")) / 100;
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("gpu-memory-utilization"));
			vllmArgs.push("--gpu-memory-utilization", String(fraction));
		}
		if (options.context) {
			const contextSizes: Record<string, number> = {
				"4k": 4096,
				"8k": 8192,
				"16k": 16384,
				"32k": 32768,
				"64k": 65536,
				"128k": 131072,
			};
			const maxTokens = contextSizes[options.context.toLowerCase()] || parseInt(options.context, 10);
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("max-model-len"));
			vllmArgs.push("--max-model-len", String(maxTokens));
		}
	}

	// Show what we're doing
	console.log(chalk.green(`Starting model '${name}' on pod '${podName}'...`));
	console.log(`Model: ${modelId}`);
	console.log(`Port: ${port}`);
	console.log(`GPU(s): ${gpus.length ? gpus.join(", ") : "Managed by vLLM"}`);
	if (modelConfig?.notes) console.log(chalk.yellow(`Note: ${modelConfig.notes}`));
	console.log("");

	// Read and customize model_run.sh script with our values
	const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/model_run.sh");
	let scriptContent = readFileSync(scriptPath, "utf-8");

	// Replace placeholders - no escaping needed, heredoc with 'EOF' is literal
	scriptContent = scriptContent
		.replace("{{MODEL_ID}}", modelId)
		.replace("{{NAME}}", name)
		.replace("{{PORT}}", String(port))
		.replace("{{VLLM_ARGS}}", vllmArgs.join(" "));

	// Upload customized script
	const result = await sshExec(
		pod.ssh,
		`cat > /tmp/model_run_${name}.sh << 'EOF'
${scriptContent}
EOF
chmod +x /tmp/model_run_${name}.sh`,
	);

	// Prepare environment
	const env = [
		`HF_TOKEN='${process.env.HF_TOKEN}'`,
		`MU_API_KEY='${process.env.MU_API_KEY}'`,
		`HF_HUB_ENABLE_HF_TRANSFER=1`,
		`VLLM_NO_USAGE_STATS=1`,
		`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`,
		`FORCE_COLOR=1`,
		`TERM=xterm-256color`,
		...(gpus.length === 1 ? [`CUDA_VISIBLE_DEVICES=${gpus[0]}`] : []),
		...Object.entries(modelConfig?.env || {}).map(([k, v]) => `${k}='${v}'`),
	]
		.map((e) => `export ${e}`)
		.join("\n");

	// Start the model runner with script command for pseudo-TTY (preserves colors)
	// Note: We use script to preserve colors and create a log file
	// setsid creates a new session so it survives SSH disconnection
	const startCmd = `
		${env}
		mkdir -p ~/.vllm_logs
		# Create a wrapper that monitors the script command
		cat > /tmp/model_wrapper_${name}.sh << 'WRAPPER'
#!/bin/bash
script -q -f -c "/tmp/model_run_${name}.sh" ~/.vllm_logs/${name}.log
exit_code=$?
echo "Script exited with code $exit_code" >> ~/.vllm_logs/${name}.log
exit $exit_code
WRAPPER
		chmod +x /tmp/model_wrapper_${name}.sh
		setsid /tmp/model_wrapper_${name}.sh </dev/null >/dev/null 2>&1 &
		echo $!
		exit 0
	`;

	const pidResult = await sshExec(pod.ssh, startCmd);
	const pid = parseInt(pidResult.stdout.trim(), 10);
	if (!pid) {
		console.error(chalk.red("Failed to start model runner"));
		process.exit(1);
	}

	// Save to config
	const config = loadConfig();
	config.pods[podName].models[name] = { model: modelId, port, gpu: gpus, pid };
	saveConfig(config);

	console.log(`Model runner started with PID: ${pid}`);
	console.log("Streaming logs... (waiting for startup)\n");

	// Small delay to ensure log file is created
	await new Promise((resolve) => setTimeout(resolve, 500));

	// Stream logs with color support, watching for startup complete
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0]; // "ssh"
	const sshArgs = sshParts.slice(1); // ["root@86.38.238.55"]
	const host = sshArgs[0].split("@")[1] || "localhost";
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	// Build the full args array for spawn
	const fullArgs = [...sshArgs, tailCmd];

	const logProcess = spawn(sshCommand, fullArgs, {
		stdio: ["inherit", "pipe", "pipe"], // capture stdout and stderr
		env: { ...process.env, FORCE_COLOR: "1" },
	});

	let interrupted = false;
	let startupComplete = false;
	let startupFailed = false;
	let failureReason = "";

	// Handle Ctrl+C
	const sigintHandler = () => {
		interrupted = true;
		logProcess.kill();
	};
	process.on("SIGINT", sigintHandler);

	// Process log output line by line
	const processOutput = (data: Buffer) => {
		const lines = data.toString().split("\n");
		for (const line of lines) {
			if (line) {
				console.log(line); // Echo the line to console

				// Check for startup complete message
				if (line.includes("Application startup complete")) {
					startupComplete = true;
					logProcess.kill(); // Stop tailing logs
				}

				// Check for failure indicators
				if (line.includes("Model runner exiting with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "Model runner failed to start";
					logProcess.kill();
				}
				if (line.includes("Script exited with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "Script failed to execute";
					logProcess.kill();
				}
				if (line.includes("torch.OutOfMemoryError") || line.includes("CUDA out of memory")) {
					startupFailed = true;
					failureReason = "Out of GPU memory (OOM)";
					// Don't kill immediately - let it show more error context
				}
				if (line.includes("RuntimeError: Engine core initialization failed")) {
					startupFailed = true;
					failureReason = "vLLM engine initialization failed";
					logProcess.kill();
				}
			}
		}
	};

	logProcess.stdout?.on("data", processOutput);
	logProcess.stderr?.on("data", processOutput);

	await new Promise<void>((resolve) => logProcess.on("exit", resolve));
	process.removeListener("SIGINT", sigintHandler);

	if (startupFailed) {
		// Model failed to start - clean up and report error
		console.log("\n" + chalk.red(`✗ Model failed to start: ${failureReason}`));

		// Remove the failed model from config
		const config = loadConfig();
		delete config.pods[podName].models[name];
		saveConfig(config);

		console.log(chalk.yellow("\nModel has been removed from configuration."));

		// Provide helpful suggestions based on failure reason
		if (failureReason.includes("OOM") || failureReason.includes("memory")) {
			console.log("\n" + chalk.bold("Suggestions:"));
			console.log("  • Try reducing GPU memory utilization: --memory 50%");
			console.log("  • Use a smaller context window: --context 4k");
			console.log("  • Use a quantized version of the model (e.g., FP8)");
			console.log("  • Use more GPUs with tensor parallelism");
			console.log("  • Try a smaller model variant");
		}

		console.log("\n" + chalk.cyan('Check full logs: mu ssh "tail -100 ~/.vllm_logs/' + name + '.log"'));
		process.exit(1);
	} else if (startupComplete) {
		// Model started successfully - output connection details
		console.log("\n" + chalk.green("✓ Model started successfully!"));
		console.log("\n" + chalk.bold("Connection Details:"));
		console.log(chalk.cyan("─".repeat(50)));
		console.log(chalk.white("Base URL:    ") + chalk.yellow(`http://${host}:${port}/v1`));
		console.log(chalk.white("Model:       ") + chalk.yellow(modelId));
		console.log(chalk.white("API Key:     ") + chalk.yellow(process.env.MU_API_KEY || "(not set)"));
		console.log(chalk.cyan("─".repeat(50)));

		console.log("\n" + chalk.bold("Export for shell:"));
		console.log(chalk.gray(`export OPENAI_BASE_URL="http://${host}:${port}/v1"`));
		console.log(chalk.gray(`export OPENAI_API_KEY="${process.env.MU_API_KEY || "your-api-key"}"`));
		console.log(chalk.gray(`export OPENAI_MODEL="${modelId}"`));

		console.log("\n" + chalk.bold("Example usage:"));
		console.log(
			chalk.gray(`
  # Python
  from openai import OpenAI
  client = OpenAI()  # Uses env vars
  response = client.chat.completions.create(
      model="${modelId}",
      messages=[{"role": "user", "content": "Hello!"}]
  )

  # CLI
  curl $OPENAI_BASE_URL/chat/completions \\
    -H "Authorization: Bearer $OPENAI_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hi"}]}'`),
		);
		console.log("");
		console.log(chalk.cyan(`Chat with model:  mu agent ${name} "Your message"`));
		console.log(chalk.cyan(`Interactive mode: mu agent ${name} -i`));
		console.log(chalk.cyan(`Monitor logs:     mu logs ${name}`));
		console.log(chalk.cyan(`Stop model:       mu stop ${name}`));
	} else if (interrupted) {
		console.log(chalk.yellow("\n\nStopped monitoring. Model deployment continues in background."));
		console.log(chalk.cyan(`Chat with model: mu agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: mu logs ${name}`));
		console.log(chalk.cyan(`Stop model: mu stop ${name}`));
	} else {
		console.log(chalk.yellow("\n\nLog stream ended. Model may still be running."));
		console.log(chalk.cyan(`Chat with model: mu agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: mu logs ${name}`));
		console.log(chalk.cyan(`Stop model: mu stop ${name}`));
	}
};

/**
 * Stop a model
 */
export const stopModel = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.yellow(`Stopping model '${name}' on pod '${podName}'...`));

	// Kill the script process and all its children
	// Using pkill to kill the process and all children
	const killCmd = `
		# Kill the script process and all its children
		pkill -TERM -P ${model.pid} 2>/dev/null || true
		kill ${model.pid} 2>/dev/null || true
	`;
	await sshExec(pod.ssh, killCmd);

	// Remove from config
	const config = loadConfig();
	delete config.pods[podName].models[name];
	saveConfig(config);

	console.log(chalk.green(`✓ Model '${name}' stopped`));
};

/**
 * Stop all models on a pod
 */
export const stopAllModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	console.log(chalk.yellow(`Stopping ${modelNames.length} model(s) on pod '${podName}'...`));

	// Kill all script processes and their children
	const pids = Object.values(pod.models).map((m) => m.pid);
	const killCmd = `
		for PID in ${pids.join(" ")}; do
			pkill -TERM -P $PID 2>/dev/null || true
			kill $PID 2>/dev/null || true
		done
	`;
	await sshExec(pod.ssh, killCmd);

	// Clear all models from config
	const config = loadConfig();
	config.pods[podName].models = {};
	saveConfig(config);

	console.log(chalk.green(`✓ Stopped all models: ${modelNames.join(", ")}`));
};

/**
 * List all models
 */
export const listModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	// Get pod SSH host for URL display
	const sshParts = pod.ssh.split(" ");
	const host = sshParts.find((p) => p.includes("@"))?.split("@")[1] || "unknown";

	console.log(`Models on pod '${chalk.bold(podName)}':`);
	for (const name of modelNames) {
		const model = pod.models[name];
		const gpuStr =
			model.gpu.length > 1
				? `GPUs ${model.gpu.join(",")}`
				: model.gpu.length === 1
					? `GPU ${model.gpu[0]}`
					: "GPU unknown";
		console.log(`  ${chalk.green(name)} - Port ${model.port} - ${gpuStr} - PID ${model.pid}`);
		console.log(`    Model: ${chalk.gray(model.model)}`);
		console.log(`    URL: ${chalk.cyan(`http://${host}:${model.port}/v1`)}`);
	}

	// Optionally verify processes are still running
	console.log("");
	console.log("Verifying processes...");
	let anyDead = false;
	for (const name of modelNames) {
		const model = pod.models[name];
		// Check both the wrapper process and if vLLM is responding
		const checkCmd = `
			# Check if wrapper process exists
			if ps -p ${model.pid} > /dev/null 2>&1; then
				# Process exists, now check if vLLM is responding
				if curl -s -f http://localhost:${model.port}/health > /dev/null 2>&1; then
					echo "running"
				else
					# Check if it's still starting up
					if tail -n 20 ~/.vllm_logs/${name}.log 2>/dev/null | grep -q "ERROR\\|Failed\\|Cuda error\\|died"; then
						echo "crashed"
					else
						echo "starting"
					fi
				fi
			else
				echo "dead"
			fi
		`;
		const result = await sshExec(pod.ssh, checkCmd);
		const status = result.stdout.trim();
		if (status === "dead") {
			console.log(chalk.red(`  ${name}: Process ${model.pid} is not running`));
			anyDead = true;
		} else if (status === "crashed") {
			console.log(chalk.red(`  ${name}: vLLM crashed (check logs with 'mu logs ${name}')`));
			anyDead = true;
		} else if (status === "starting") {
			console.log(chalk.yellow(`  ${name}: Still starting up...`));
		}
	}

	if (anyDead) {
		console.log("");
		console.log(chalk.yellow("Some models are not running. Clean up with:"));
		console.log(chalk.cyan("  mu stop <name>"));
	} else {
		console.log(chalk.green("✓ All processes verified"));
	}
};

/**
 * View model logs
 */
export const viewLogs = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.green(`Streaming logs for '${name}' on pod '${podName}'...`));
	console.log(chalk.gray("Press Ctrl+C to stop"));
	console.log("");

	// Stream logs with color preservation
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0]; // "ssh"
	const sshArgs = sshParts.slice(1); // ["root@86.38.238.55"]
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	const logProcess = spawn(sshCommand, [...sshArgs, tailCmd], {
		stdio: "inherit",
		env: {
			...process.env,
			FORCE_COLOR: "1",
		},
	});

	// Wait for process to exit
	await new Promise<void>((resolve) => {
		logProcess.on("exit", () => resolve());
	});
};

/**
 * Show known models and their hardware requirements
 */
export const showKnownModels = async () => {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const modelsJsonPath = join(__dirname, "..", "models.json");
	const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
	const models = modelsJson.models;

	// Get active pod info if available
	const activePod = getActivePod();
	let podGpuCount = 0;
	let podGpuType = "";

	if (activePod) {
		podGpuCount = activePod.pod.gpus.length;
		// Extract GPU type from name (e.g., "NVIDIA H200" -> "H200")
		podGpuType = activePod.pod.gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

		console.log(chalk.bold(`Known Models for ${activePod.name} (${podGpuCount}x ${podGpuType || "GPU"}):\n`));
	} else {
		console.log(chalk.bold("Known Models:\n"));
		console.log(chalk.yellow("No active pod. Use 'mu pods active <name>' to filter compatible models.\n"));
	}

	console.log("Usage: pi start <model> --name <name> [options]\n");

	// Group models by compatibility and family
	const compatible: Record<string, Array<{ id: string; name: string; config: string; notes?: string }>> = {};
	const incompatible: Record<string, Array<{ id: string; name: string; minGpu: string; notes?: string }>> = {};

	for (const [modelId, info] of Object.entries(models)) {
		const modelInfo = info as any;
		const family = modelInfo.name.split("-")[0] || "Other";

		let isCompatible = false;
		let compatibleConfig = "";
		let minGpu = "Unknown";
		let minNotes: string | undefined;

		if (modelInfo.configs && modelInfo.configs.length > 0) {
			// Sort configs by GPU count to find minimum
			const sortedConfigs = [...modelInfo.configs].sort((a: any, b: any) => (a.gpuCount || 1) - (b.gpuCount || 1));

			// Find minimum requirements
			const minConfig = sortedConfigs[0];
			const minGpuCount = minConfig.gpuCount || 1;
			const gpuTypes = minConfig.gpuTypes?.join("/") || "H100/H200";

			if (minGpuCount === 1) {
				minGpu = `1x ${gpuTypes}`;
			} else {
				minGpu = `${minGpuCount}x ${gpuTypes}`;
			}

			minNotes = minConfig.notes || modelInfo.notes;

			// Check compatibility with active pod
			if (activePod && podGpuCount > 0) {
				// Find best matching config for this pod
				for (const config of sortedConfigs) {
					const configGpuCount = config.gpuCount || 1;
					const configGpuTypes = config.gpuTypes || [];

					// Check if we have enough GPUs
					if (configGpuCount <= podGpuCount) {
						// Check if GPU type matches (if specified)
						if (
							configGpuTypes.length === 0 ||
							configGpuTypes.some((type: string) => podGpuType.includes(type) || type.includes(podGpuType))
						) {
							isCompatible = true;
							if (configGpuCount === 1) {
								compatibleConfig = `1x ${podGpuType}`;
							} else {
								compatibleConfig = `${configGpuCount}x ${podGpuType}`;
							}
							minNotes = config.notes || modelInfo.notes;
							break;
						}
					}
				}
			}
		}

		const modelEntry = {
			id: modelId,
			name: modelInfo.name,
			notes: minNotes,
		};

		if (activePod && isCompatible) {
			if (!compatible[family]) {
				compatible[family] = [];
			}
			compatible[family].push({ ...modelEntry, config: compatibleConfig });
		} else {
			if (!incompatible[family]) {
				incompatible[family] = [];
			}
			incompatible[family].push({ ...modelEntry, minGpu });
		}
	}

	// Display compatible models first
	if (activePod && Object.keys(compatible).length > 0) {
		console.log(chalk.green.bold("✓ Compatible Models:\n"));

		const sortedFamilies = Object.keys(compatible).sort();
		for (const family of sortedFamilies) {
			console.log(chalk.cyan(`${family} Models:`));

			const modelList = compatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				console.log(`  ${chalk.green(model.id)}`);
				console.log(`    Name: ${model.name}`);
				console.log(`    Config: ${model.config}`);
				if (model.notes) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				console.log("");
			}
		}
	}

	// Display incompatible models
	if (Object.keys(incompatible).length > 0) {
		if (activePod && Object.keys(compatible).length > 0) {
			console.log(chalk.red.bold("✗ Incompatible Models (need more/different GPUs):\n"));
		}

		const sortedFamilies = Object.keys(incompatible).sort();
		for (const family of sortedFamilies) {
			if (!activePod) {
				console.log(chalk.cyan(`${family} Models:`));
			} else {
				console.log(chalk.gray(`${family} Models:`));
			}

			const modelList = incompatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				const color = activePod ? chalk.gray : chalk.green;
				console.log(`  ${color(model.id)}`);
				console.log(chalk.gray(`    Name: ${model.name}`));
				console.log(chalk.gray(`    Min Hardware: ${model.minGpu}`));
				if (model.notes && !activePod) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				if (activePod) {
					console.log(""); // Less verbose for incompatible models when filtered
				} else {
					console.log("");
				}
			}
		}
	}

	console.log(chalk.gray("\nFor unknown models, defaults to single GPU deployment."));
	console.log(chalk.gray("Use --vllm to pass custom arguments to vLLM."));
};
