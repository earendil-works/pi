const APP_STATE = {
	sessionId: null,
	isStreaming: false,
	currentMessageId: null,
	models: [],
};

const ELEMENTS = {
	messagesContainer: document.getElementById("messagesContainer"),
	messageInput: document.getElementById("messageInput"),
	sendBtn: document.getElementById("sendBtn"),
	stopBtn: document.getElementById("stopBtn"),
	newSessionBtn: document.getElementById("newSessionBtn"),
	modelSelect: document.getElementById("modelSelect"),
	thinkingSelect: document.getElementById("thinkingSelect"),
	statusText: document.getElementById("statusText"),
	statusDot: null,
};

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 2000;

function showStatus(message, type = "info") {
	ELEMENTS.statusText.textContent = message;

	let dotClass = "status-dot";
	switch (type) {
		case "connected":
			dotClass += " connected";
			break;
		case "disconnected":
			dotClass += " disconnected";
			break;
		case "connecting":
			dotClass += " connecting";
			break;
	}

	const statusBar = document.querySelector(".status-bar");
	let dot = statusBar.querySelector(".status-dot");
	if (!dot) {
		dot = document.createElement("span");
		statusBar.insertBefore(dot, statusBar.firstChild);
	}
	dot.className = dotClass;
}

function updateUI() {
	const connected = ws && ws.readyState === WebSocket.OPEN;
	const sessionActive = !!APP_STATE.sessionId;
	const canInteract = connected && sessionActive && !APP_STATE.isStreaming;

	ELEMENTS.messageInput.disabled = !canInteract;
	ELEMENTS.sendBtn.disabled = !canInteract;
	ELEMENTS.modelSelect.disabled = !sessionActive;
	ELEMENTS.thinkingSelect.disabled = !sessionActive;

	ELEMENTS.sendBtn.style.display = APP_STATE.isStreaming ? "none" : "inline-flex";
	ELEMENTS.stopBtn.style.display = APP_STATE.isStreaming ? "inline-flex" : "none";
}

function clearMessages() {
	ELEMENTS.messagesContainer.innerHTML = "";
}

function addWelcomeMessage() {
	const div = document.createElement("div");
	div.className = "welcome-message";
	div.innerHTML = `
		<h2>Welcome to Pi Web</h2>
		<p>Your AI coding assistant is ready. Start typing to begin.</p>
	`;
	ELEMENTS.messagesContainer.appendChild(div);
}

function addMessage(role, content, id = null) {
	const messageId = id || `msg-${Date.now()}`;

	const div = document.createElement("div");
	div.className = `message ${role}`;
	div.id = messageId;

	const header = document.createElement("div");
	header.className = "message-header";

	const avatar = document.createElement("div");
	avatar.className = "message-avatar";
	avatar.textContent = role === "user" ? "U" : "AI";

	const name = document.createElement("span");
	name.textContent = role === "user" ? "You" : "Assistant";

	header.appendChild(avatar);
	header.appendChild(name);

	const contentDiv = document.createElement("div");
	contentDiv.className = "message-content";
	contentDiv.innerHTML = formatContent(content);

	div.appendChild(header);
	div.appendChild(contentDiv);

	ELEMENTS.messagesContainer.appendChild(div);
	scrollToBottom();

	return messageId;
}

function updateMessage(id, content) {
	const div = document.getElementById(id);
	if (!div) return;

	const contentDiv = div.querySelector(".message-content");
	if (contentDiv) {
		contentDiv.innerHTML = formatContent(content);
	}
	scrollToBottom();
}

function addTypingIndicator() {
	const div = document.createElement("div");
	div.className = "typing-indicator";
	div.id = "typing-indicator";
	div.innerHTML = `
		<span class="typing-dot"></span>
		<span class="typing-dot"></span>
		<span class="typing-dot"></span>
	`;
	ELEMENTS.messagesContainer.appendChild(div);
	scrollToBottom();
}

function removeTypingIndicator() {
	const indicator = document.getElementById("typing-indicator");
	if (indicator) {
		indicator.remove();
	}
}

function addToolMessage(toolName, args) {
	const div = document.createElement("div");
	div.className = "tool-message";

	const nameDiv = document.createElement("div");
	nameDiv.className = "tool-name";
	nameDiv.textContent = `Tool: ${toolName}`;

	const argsDiv = document.createElement("div");
	argsDiv.className = "tool-args";
	argsDiv.textContent = JSON.stringify(args, null, 2);

	div.appendChild(nameDiv);
	div.appendChild(argsDiv);

	// Find the last assistant message and append to it, or add as new
	const lastAssistant = document.querySelector(".message.assistant:last-child");
	if (lastAssistant) {
		lastAssistant.appendChild(div);
	} else {
		ELEMENTS.messagesContainer.appendChild(div);
	}
	scrollToBottom();
}

function formatContent(content) {
	if (!content) return "";

	// Replace code blocks
	content = content.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
		const language = lang ? ` class="language-${lang}"` : "";
		return `<pre><code${language}>${escapeHtml(code)}</code></pre>`;
	});

	// Replace inline code
	content = content.replace(/`([^`]+)`/g, "<code>$1</code>");

	// Replace newlines
	content = content.replace(/\n/g, "<br>");

	return content;
}

function escapeHtml(text) {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}

function scrollToBottom() {
	ELEMENTS.messagesContainer.scrollTop = ELEMENTS.messagesContainer.scrollHeight;
}

function connectWebSocket() {
	showStatus("Connecting...", "connecting");

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const wsUrl = `${protocol}//${window.location.host}`;

	ws = new WebSocket(wsUrl);

	ws.onopen = () => {
		console.log("WebSocket connected");
		showStatus("Connected", "connected");
		reconnectAttempts = 0;

		// Load models
		if (APP_STATE.sessionId) {
			sendMessage({ type: "get_available_models", sessionId: APP_STATE.sessionId });
		}
	};

	ws.onclose = () => {
		console.log("WebSocket closed");
		showStatus("Disconnected", "disconnected");
		updateUI();

		if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
			reconnectAttempts++;
			showStatus(`Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, "connecting");
			setTimeout(connectWebSocket, RECONNECT_DELAY);
		}
	};

	ws.onerror = (error) => {
		console.error("WebSocket error:", error);
	};

	ws.onmessage = (event) => {
		handleServerMessage(JSON.parse(event.data));
	};
}

function handleServerMessage(message) {
	console.log("Received:", message);

	switch (message.type) {
		case "session_created":
			APP_STATE.sessionId = message.sessionId;
			clearMessages();
			addWelcomeMessage();

			// Load models
			sendMessage({
				type: "get_available_models",
				sessionId: APP_STATE.sessionId,
			});

			// Set initial thinking level
			const initialLevel = ELEMENTS.thinkingSelect.value;
			if (initialLevel) {
				sendMessage({
					type: "set_thinking_level",
					sessionId: APP_STATE.sessionId,
					level: initialLevel,
				});
			}

			updateUI();
			break;

		case "event":
			handleAgentEvent(message.event);
			break;

		case "models":
			APP_STATE.models = message.models;
			populateModelSelect(message.models);
			updateUI();
			break;

		case "model_set":
			console.log("Model set:", message.model);
			break;

		case "state":
			handleStateUpdate(message.state);
			break;

		case "error":
			console.error("Server error:", message.message);
			showStatus(`Error: ${message.message}`, "disconnected");
			break;

		case "ack":
			// Acknowledgment, do nothing
			break;
	}
}

function handleAgentEvent(event) {
	console.log("Agent event:", event.type);

	switch (event.type) {
		case "message_start":
			APP_STATE.isStreaming = true;
			APP_STATE.currentMessageId = addMessage("assistant", "");
			addTypingIndicator();
			updateUI();
			break;

		case "message_update":
			removeTypingIndicator();
			if (APP_STATE.currentMessageId) {
				updateMessage(APP_STATE.currentMessageId, event.content);
			}
			break;

		case "message_end":
			APP_STATE.isStreaming = false;
			APP_STATE.currentMessageId = null;
			removeTypingIndicator();
			updateUI();
			break;

		case "tool_call_start":
			addToolMessage(event.toolName, event.args);
			break;

		case "turn_start":
			console.log("Turn started");
			break;

		case "turn_end":
			console.log("Turn ended");
			break;

		case "state_update":
			// Handle state changes if needed
			break;
	}
}

function handleStateUpdate(state) {
	APP_STATE.isStreaming = state.isStreaming;
	updateUI();
}

function populateModelSelect(models) {
	ELEMENTS.modelSelect.innerHTML = '<option value="">Select a model...</option>';

	models.forEach((model) => {
		const option = document.createElement("option");
		option.value = `${model.provider}:${model.id}`;
		option.textContent = `${model.id} (${model.provider})`;

		// Select the first model by default
		if (model.isDefault) {
			option.selected = true;
		}

		ELEMENTS.modelSelect.appendChild(option);
	});
}

function sendMessage(message) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		console.log("Sending:", message);
		ws.send(JSON.stringify(message));
	}
}

function sendUserMessage() {
	const content = ELEMENTS.messageInput.value.trim();
	if (!content || !APP_STATE.sessionId || APP_STATE.isStreaming) return;

	// Add user message
	addMessage("user", content);

	// Clear input
	ELEMENTS.messageInput.value = "";
	ELEMENTS.messageInput.style.height = "auto";

	// Send to server
	sendMessage({
		type: "send_message",
		sessionId: APP_STATE.sessionId,
		message: content,
	});
}

function createNewSession() {
	APP_STATE.sessionId = null;
	APP_STATE.isStreaming = false;
	APP_STATE.currentMessageId = null;

	sendMessage({
		type: "create_session",
		cwd: ".",
	});
}

function abortCurrentStream() {
	if (APP_STATE.sessionId && APP_STATE.isStreaming) {
		sendMessage({
			type: "abort",
			sessionId: APP_STATE.sessionId,
		});
	}
}

function autoResize(textarea) {
	textarea.style.height = "auto";
	textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
}

// Event Listeners
ELEMENTS.sendBtn.addEventListener("click", sendUserMessage);

ELEMENTS.stopBtn.addEventListener("click", abortCurrentStream);

ELEMENTS.newSessionBtn.addEventListener("click", createNewSession);

ELEMENTS.messageInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendUserMessage();
	}
});

ELEMENTS.messageInput.addEventListener("input", () => {
	autoResize(ELEMENTS.messageInput);
});

ELEMENTS.modelSelect.addEventListener("change", () => {
	const value = ELEMENTS.modelSelect.value;
	if (!value || !APP_STATE.sessionId) return;

	const [provider, modelId] = value.split(":");
	sendMessage({
		type: "set_model",
		sessionId: APP_STATE.sessionId,
		provider,
		modelId,
	});
});

ELEMENTS.thinkingSelect.addEventListener("change", () => {
	const value = ELEMENTS.thinkingSelect.value;
	if (!APP_STATE.sessionId) return;

	sendMessage({
		type: "set_thinking_level",
		sessionId: APP_STATE.sessionId,
		level: value,
	});
});

// Initialize
updateUI();
connectWebSocket();

// Create initial session after a short delay
setTimeout(() => {
	createNewSession();
}, 500);
