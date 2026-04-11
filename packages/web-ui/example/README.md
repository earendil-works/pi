# Pi Web UI - Example

This is a minimal example showing how to use `@tculpepp/pi-web-ui` in a web application.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## What's Included

This example demonstrates:

- **ChatPanel** - The main chat interface component
- **System Prompt** - Custom configuration for the AI assistant
- **Tools** - JavaScript REPL and artifacts tool

## Configuration

### API Keys

The example uses **Direct Mode** by default, which means it calls AI provider APIs directly from the browser.

To use the chat:

1. Click the settings icon (⚙️) in the chat interface
2. Click "Manage API Keys"
3. Add your API key for your preferred provider:
   - **Anthropic**: Get a key from [console.anthropic.com](https://console.anthropic.com/)
   - **OpenAI**: Get a key from [platform.openai.com](https://platform.openai.com/)
   - **Google**: Get a key from [makersuite.google.com](https://makersuite.google.com/)

API keys are stored in your browser's localStorage and never sent to any server except the AI provider's API.

## Project Structure

```
example/
├── src/
│   ├── main.ts       # Main application entry point
│   └── app.css       # Tailwind CSS configuration
├── index.html        # HTML entry point
├── package.json      # Dependencies
├── vite.config.ts    # Vite configuration
└── tsconfig.json     # TypeScript configuration
```

## Learn More

- [Pi Web UI Documentation](../README.md)
- [Pi AI Documentation](../../ai/README.md)
- [Mini Lit Documentation](https://github.com/badlogic/mini-lit)
