# webui-ws-protocol Specification

## MODIFIED Requirements

### Requirement: Prompt Message Images Field

The WebSocket `prompt` message SHALL accept an `images` field of type `Array<{mediaType: string, data: string}>` (replacing the prior `string[]` schema). Each entry's `mediaType` SHALL be one of `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Each entry's `data` SHALL be a base64-encoded string (no data URL prefix) of length at most 5MB. The array length SHALL be at most 4. The sum of all `data` lengths SHALL be at most 20MB.

#### Scenario: Valid prompt with images
- **GIVEN** a client sends `{type:"prompt", text:"look", images:[{mediaType:"image/png", data:"<2MB base64>"}], sessionId:"abc"}`
- **WHEN** the server's WS handler validates the message
- **THEN** the validation passes and `pool.prompt("abc", "look", [{mediaType:"image/png", data:"<base64>"}])` is called

#### Scenario: Reject more than 4 images
- **GIVEN** a client sends 5 images
- **WHEN** the WS handler validates
- **THEN** it sends `{type:"error", message:"invalid prompt"}` to the client
- **AND** no prompt is forwarded to the pool

#### Scenario: Reject image > 5MB
- **GIVEN** a client sends an image with `data` of length 6MB
- **WHEN** the WS handler validates
- **THEN** it sends an error and no prompt is forwarded

#### Scenario: Reject total > 20MB
- **GIVEN** a client sends 4 images with `data` totaling 21MB
- **WHEN** the WS handler validates
- **THEN** it sends an error and no prompt is forwarded

#### Scenario: Reject unsupported MIME
- **GIVEN** a client sends `{mediaType:"image/bmp", data:"<base64>"}`
- **WHEN** the WS handler validates
- **THEN** it sends an error and no prompt is forwarded

### Requirement: Server Stdin Content Array

The `SessionPool.prompt(sessionId, text, images?)` method SHALL write to the pi process's stdin a JSON line of the form:
```json
{"type":"prompt", "sessionId":"<id>", "content":[{"type":"text", "text":"<text>"}, ...images.map(i => ({type:"image", mediaType:i.mediaType, data:i.data}))], "message":"<text>"}
```

The `content` field SHALL be a JSON array of parts, with the first part being the text and subsequent parts being the images in order. The legacy `message` field SHALL still be present for backward compatibility with older pi core versions.

#### Scenario: Prompt with one image writes content array
- **GIVEN** a session is running and `prompt(sessionId, "hello", [{mediaType:"image/png", data:"abc"}])` is called
- **WHEN** the server writes to the pi process stdin
- **THEN** the written JSON includes `content: [{type:"text", text:"hello"}, {type:"image", mediaType:"image/png", data:"abc"}]`
- **AND** the `message` field equals "hello"

#### Scenario: Text-only prompt still works
- **GIVEN** a session is running and `prompt(sessionId, "hello")` is called
- **WHEN** the server writes to the pi process stdin
- **THEN** the written JSON includes `content: [{type:"text", text:"hello"}]`
- **AND** the `message` field equals "hello"
- **AND** no `images` field is present in the content array

## ADDED Requirements

### Requirement: GET Models Endpoint

The webui server SHALL expose `GET /api/models` which reads `~/.pi/agent/models.json`, parses it via `parseModelsJson`, and returns `{providers: [{name, models: [{id, name}]}]}` as JSON.

If the file is missing, empty, or malformed, the endpoint SHALL return `{providers: []}` with HTTP 200 (not 500).

#### Scenario: Returns parsed providers
- **GIVEN** `models.json` contains `{"providers":[{"name":"anthropic","models":[{"id":"claude-sonnet-4-6","name":"Claude Sonnet 4.6"}]}]}`
- **WHEN** the client GETs `/api/models`
- **THEN** the response is 200 with body `{providers: [{name: "anthropic", models: [{id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6"}]}]}`

#### Scenario: Missing file returns empty
- **GIVEN** `models.json` does not exist
- **WHEN** the client GETs `/api/models`
- **THEN** the response is 200 with body `{providers: []}`

### Requirement: GET Settings Endpoint

The webui server SHALL expose `GET /api/settings` which reads `~/.pi/agent/settings.json` and returns the full object as JSON. The endpoint SHALL return 200 with an empty object `{}` if the file is missing or invalid.

#### Scenario: Returns current settings
- **GIVEN** `settings.json` contains `{webui: {theme: "hermes", defaultModel: "anthropic/claude-sonnet-4-6"}}`
- **WHEN** the client GETs `/api/settings`
- **THEN** the response is 200 with the full settings object

#### Scenario: Missing settings file
- **GIVEN** `settings.json` does not exist
- **WHEN** the client GETs `/api/settings`
- **THEN** the response is 200 with body `{}`

### Requirement: PATCH Settings Endpoint

The webui server SHALL expose `PATCH /api/settings` which accepts a partial settings object in the request body, deep-merges it with the existing `settings.json`, and writes the result back. The endpoint SHALL return 200 with the updated object.

#### Scenario: Update default model
- **GIVEN** current settings have no `webui.defaultModel`
- **WHEN** the client PATCHes `/api/settings` with `{webui: {defaultModel: "openai/gpt-4o"}}`
- **THEN** the server writes `{webui: {defaultModel: "openai/gpt-4o"}}` to settings.json
- **AND** the response is 200 with the updated object

#### Scenario: Preserve other settings
- **GIVEN** current settings have `{personalAssistant: {...}, webui: {theme: "hermes"}}`
- **WHEN** the client PATCHes with `{webui: {defaultModel: "openai/gpt-4o"}}`
- **THEN** the written file is `{personalAssistant: {...}, webui: {theme: "hermes", defaultModel: "openai/gpt-4o"}}`
- **AND** other top-level fields are preserved
