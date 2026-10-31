// Every built-in provider catalog. Add new providers here.

import type { ProviderDefinition } from "../define.ts";
import alibaba from "./alibaba.ts";
import alibabaCn from "./alibaba-cn.ts";
import amazonBedrock from "./amazon-bedrock.ts";
import antLing from "./ant-ling.ts";
import anthropic from "./anthropic.ts";
import azure from "./azure.ts";
import baseten from "./baseten.ts";
import cerebras from "./cerebras.ts";
import cloudflareAiGateway from "./cloudflare-ai-gateway.ts";
import cloudflareWorkersAi from "./cloudflare-workers-ai.ts";
import deepinfra from "./deepinfra.ts";
import deepseek from "./deepseek.ts";
import fireworks from "./fireworks.ts";
import githubCopilot from "./github-copilot.ts";
import google from "./google.ts";
import googleVertex from "./google-vertex.ts";
import groq from "./groq.ts";
import huggingface from "./huggingface.ts";
import kimiCoding from "./kimi-coding.ts";
import meta from "./meta.ts";
import minimax from "./minimax.ts";
import minimaxCn from "./minimax-cn.ts";
import mistral from "./mistral.ts";
import moonshotai from "./moonshotai.ts";
import moonshotaiCn from "./moonshotai-cn.ts";
import nebius from "./nebius.ts";
import nvidia from "./nvidia.ts";
import ollamaCloud from "./ollama-cloud.ts";
import openai from "./openai.ts";
import openaiCodex from "./openai-codex.ts";
import opencode from "./opencode.ts";
import opencodeGo from "./opencode-go.ts";
import openrouter from "./openrouter.ts";
import qwenTokenPlan from "./qwen-token-plan.ts";
import qwenTokenPlanCn from "./qwen-token-plan-cn.ts";
import qwenTokenPlanIndividual from "./qwen-token-plan-individual.ts";
import radius from "./radius.ts";
import scaleway from "./scaleway.ts";
import siliconflow from "./siliconflow.ts";
import siliconflowCn from "./siliconflow-cn.ts";
import stepfun from "./stepfun.ts";
import stepfunCn from "./stepfun-cn.ts";
import together from "./together.ts";
import typesafe from "./typesafe.ts";
import vercelAiGateway from "./vercel-ai-gateway.ts";
import xai from "./xai.ts";
import xiaomi from "./xiaomi.ts";
import xiaomiTokenPlanAms from "./xiaomi-token-plan-ams.ts";
import xiaomiTokenPlanCn from "./xiaomi-token-plan-cn.ts";
import xiaomiTokenPlanSgp from "./xiaomi-token-plan-sgp.ts";
import zai from "./zai.ts";
import zaiApi from "./zai-api.ts";
import zaiApiCn from "./zai-api-cn.ts";
import zaiCodingCn from "./zai-coding-cn.ts";

export const PROVIDERS: readonly ProviderDefinition[] = [
	alibabaCn,
	alibaba,
	amazonBedrock,
	antLing,
	anthropic,
	azure,
	baseten,
	cerebras,
	cloudflareAiGateway,
	cloudflareWorkersAi,
	deepinfra,
	deepseek,
	fireworks,
	githubCopilot,
	googleVertex,
	google,
	groq,
	huggingface,
	kimiCoding,
	meta,
	minimaxCn,
	minimax,
	mistral,
	moonshotaiCn,
	moonshotai,
	nebius,
	nvidia,
	ollamaCloud,
	openaiCodex,
	openai,
	opencodeGo,
	opencode,
	openrouter,
	qwenTokenPlanCn,
	qwenTokenPlanIndividual,
	qwenTokenPlan,
	radius,
	scaleway,
	siliconflowCn,
	siliconflow,
	stepfunCn,
	stepfun,
	together,
	typesafe,
	vercelAiGateway,
	xai,
	xiaomiTokenPlanAms,
	xiaomiTokenPlanCn,
	xiaomiTokenPlanSgp,
	xiaomi,
	zaiApiCn,
	zaiApi,
	zaiCodingCn,
	zai,
];
