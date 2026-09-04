# Providers and models

`pi-ai` includes Anthropic, OpenAI, OpenAI Codex, Azure OpenAI, Google Gemini/Vertex, Amazon Bedrock, Mistral, DeepSeek, xAI, Groq, Cerebras, OpenRouter, Vercel AI Gateway, Cloudflare, Fireworks, Together, Baseten, Hugging Face, ZAI, MiniMax, Moonshot, Kimi, Qwen, Xiaomi, OpenCode, GitHub Copilot, and compatible endpoints.

Custom providers use `~/.pi/agent/models.json`:

```json
{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","api":"openai-completions","apiKey":"ollama","models":[{"id":"qwen3"}]}}}
```

Run `pi update --models` to refresh signed catalog overlays from pi.dev.
