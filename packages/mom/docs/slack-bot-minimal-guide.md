# Minimal Slack Bot Setup (No Web Server, WebSocket Only)

Here's how to connect your Node.js agent to Slack using **Socket Mode** - no Express, no HTTP server, just WebSockets and callbacks.

---

## 1. Dependencies

```bash
npm install @slack/socket-mode @slack/web-api
```

That's it. Two packages:
- `@slack/socket-mode` - Receives events via WebSocket
- `@slack/web-api` - Sends messages back to Slack

---

## 2. Get Your Tokens

You need **TWO tokens**:

### A. Bot Token (`xoxb-...`)
1. Go to https://api.slack.com/apps
2. Create app → "From scratch"
3. Click "OAuth & Permissions" in sidebar
4. Add **Bot Token Scopes** (all 17 below; omit `reactions:write` only if you disable `MOM_SLACK_STATUS_REACTIONS`):
   ```
   app_mentions:read
   channels:history
   channels:join
   channels:read
   chat:write
   files:read
   files:write
   groups:history
   groups:read
   im:history
   im:read
   im:write
   mpim:history
   mpim:read
   mpim:write
   reactions:write
   users:read
   ```
5. Click "Install to Workspace" at top
6. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

### B. App-Level Token (`xapp-...`)
1. In same app, click "Basic Information" in sidebar
2. Scroll to "App-Level Tokens"
3. Click "Generate Token and Scopes"
4. Name it whatever (e.g., "socket-token")
5. Add scope: `connections:write`
6. Click "Generate"
7. Copy the token (starts with `xapp-`)

---

## 3. Enable Socket Mode

1. Go to https://api.slack.com/apps → select your app
2. Click **"Socket Mode"** in sidebar
3. Toggle **"Enable Socket Mode"** to ON
4. This routes your app's interactions and events over WebSockets instead of public HTTP endpoints
5. Done - no webhook URL needed!

**Note:** Socket Mode is intended for internal apps in development or behind a firewall. Not for apps distributed via Slack Marketplace.

---

## 4. Enable Direct Messages

1. Go to https://api.slack.com/apps → select your app
2. Click **"App Home"** in sidebar
3. Scroll to **"Show Tabs"** section
4. Check **"Allow users to send Slash commands and messages from the messages tab"**
5. Save

---

## 5. Subscribe to Events

1. Go to https://api.slack.com/apps → select your app
2. Click **"Event Subscriptions"** in sidebar
3. Toggle **"Enable Events"** to ON
4. **Important:** No Request URL needed (Socket Mode handles this)
5. Expand **"Subscribe to bot events"**
6. Click **"Add Bot User Event"** and add:
   - `app_mention` (required - to see when bot is mentioned)
   - `message.channels` (required - to log all channel messages for context)
   - `message.groups` (optional - to see private channel messages)
   - `message.im` (required - to see DMs)
7. Click **"Save Changes"** at bottom

---

## 6. Store Tokens

Create `.env` file:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

Add to `.gitignore`:

```bash
echo ".env" >> .gitignore
```

---

## 7. Minimal Working Code

```javascript
require('dotenv').config();
const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');

const socketClient = new SocketModeClient({ 
  appToken: process.env.SLACK_APP_TOKEN 
});

const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// Listen for app mentions (@mom do something)
socketClient.on('app_mention', async ({ event, ack }) => {
  try {
    // Acknowledge receipt
    await ack();
    
    console.log('Mentioned:', event.text);
    console.log('Channel:', event.channel);
    console.log('User:', event.user);
    
    // Process with your agent
    const response = await yourAgentFunction(event.text);
    
    // Send response
    await webClient.chat.postMessage({
      channel: event.channel,
      text: response
    });
  } catch (error) {
    console.error('Error:', error);
  }
});

// Start the connection
(async () => {
  await socketClient.start();
  console.log('⚡️ Bot connected and listening!');
})();

// Your existing agent logic
async function yourAgentFunction(text) {
  // Your code here
  return "I processed: " + text;
}
```

**That's it. No web server. Just run it:**

```bash
node bot.js
```

---

## 8. Listen to ALL Events (Not Just Mentions)

If you want to see every message in channels/DMs the bot is in:

```javascript
// Listen to all Slack events
socketClient.on('slack_event', async ({ event, body, ack }) => {
  await ack();
  
  console.log('Event type:', event.type);
  console.log('Event data:', event);
  
  if (event.type === 'message' && event.subtype === undefined) {
    // Regular message (not bot message, not edited, etc.)
    console.log('Message:', event.text);
    console.log('Channel:', event.channel);
    console.log('User:', event.user);
    
    // Your logic here
  }
});
```

---

## 9. Common Operations

### Send a message
```javascript
await webClient.chat.postMessage({
  channel: 'C12345', // or channel ID from event
  text: 'Hello!'
});
```

### Send a DM
```javascript
// Open DM channel with user
const result = await webClient.conversations.open({
  users: 'U12345' // user ID
});

// Send message to that DM
await webClient.chat.postMessage({
  channel: result.channel.id,
  text: 'Hey there!'
});
```

### List channels
```javascript
const channels = await webClient.conversations.list({
  types: 'public_channel,private_channel'
});
console.log(channels.channels);
```

### Get channel members
```javascript
const members = await webClient.conversations.members({
  channel: 'C12345'
});
console.log(members.members); // Array of user IDs
```

### Get user info
```javascript
const user = await webClient.users.info({
  user: 'U12345'
});
console.log(user.user.name);
console.log(user.user.real_name);
```

### Join a channel
```javascript
await webClient.conversations.join({
  channel: 'C12345'
});
```

### Upload a file
```javascript
await webClient.files.uploadV2({
  channel_id: 'C12345',
  file: fs.createReadStream('./file.pdf'),
  filename: 'document.pdf',
  title: 'My Document'
});
```

---

## 10. Complete Example with Your Agent

```javascript
require('dotenv').config();
const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');

const socketClient = new SocketModeClient({ 
  appToken: process.env.SLACK_APP_TOKEN 
});

const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// Your existing agent/AI/whatever
class MyAgent {
  async process(message, context) {
    // Your complex logic here
    // context has: user, channel, etc.
    return `Processed: ${message}`;
  }
}

const agent = new MyAgent();

// Handle mentions
socketClient.on('app_mention', async ({ event, ack }) => {
  await ack();
  
  try {
    // Remove the @mention from text
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    
    // Process with your agent
    const response = await agent.process(text, {
      user: event.user,
      channel: event.channel
    });
    
    // Send response
    await webClient.chat.postMessage({
      channel: event.channel,
      text: response
    });
  } catch (error) {
    console.error('Error processing mention:', error);
    
    // Send error message
    await webClient.chat.postMessage({
      channel: event.channel,
      text: 'Sorry, something went wrong!'
    });
  }
});

// Start
(async () => {
  await socketClient.start();
  console.log('⚡️ Agent connected to Slack!');
})();
```

---

## 11. Available Event Types

You subscribed to these in step 4:

- `app_mention` - Someone @mentioned the bot
- `message` - Any message in a channel/DM the bot is in

Event object structure:

```javascript
{
  type: 'app_mention' or 'message',
  text: 'the message text',
  user: 'U12345', // who sent it
  channel: 'C12345', // where it was sent
  ts: '1234567890.123456' // timestamp
}
```

---

## 12. Advantages of Socket Mode

✅ **No web server needed** - just run your script  
✅ **No public URL needed** - works behind firewall  
✅ **No ngrok** - works on localhost  
✅ **Auto-reconnect** - SDK handles connection drops  
✅ **Event-driven** - just listen to callbacks  

---

## 13. Disadvantages

❌ Can't distribute to Slack App Directory (only for your workspace)  
❌ Script must be running to receive messages (unlike webhooks)  
❌ Max 10 concurrent connections per app  

---

## Important Notes

1. **You MUST call `ack()`** on every event or Slack will retry
2. **Bot token** (`xoxb-`) is for sending messages
3. **App token** (`xapp-`) is for receiving events via WebSocket
4. **Connection is persistent** - your script stays running
5. **No URL validation** needed (unlike HTTP webhooks)

---

## Troubleshooting

### "invalid_auth" error
- Check you're using the right tokens
- Bot token for WebClient, App token for SocketModeClient

### "missing_scope" error
- Make sure you added all 16 bot scopes
- Reinstall the app after adding scopes

### Not receiving events
- Check Socket Mode is enabled
- Check you subscribed to events in "Event Subscriptions"
- Make sure bot is in the channel (or use `channels:join`)

### Bot doesn't respond to mentions
- Must subscribe to `app_mention` event
- Bot must be installed to workspace
- Check `await ack()` is called

---

That's it. No HTTP server bullshit. Just WebSockets and callbacks.
