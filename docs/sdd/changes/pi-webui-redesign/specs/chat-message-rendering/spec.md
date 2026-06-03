# chat-message-rendering Specification

## MODIFIED Requirements

### Requirement: Three-Segment Assistant Message

The webui SHALL render an assistant message as three sequential segments: `MessageHeader` (identity), `MessageParts` (body), and `MessageFooter` (cost). Each segment is rendered in order with no extra wrapping.

The `MessageHeader` SHALL contain: a circular 24px avatar (default blue background, single uppercase letter from the assistant's name), the assistant's name (default "pi"), a relative timestamp (e.g. "2h ago"), and an optional model badge (gray pill) if the message has a `model` field.

The `MessageFooter` SHALL contain: a token usage line in the format `${formatToken(input)} in · ${formatToken(output)} out`, right-aligned and 10px gray, rendered only when `message.usage` is defined.

#### Scenario: Header renders identity
- **GIVEN** an assistant message with name "pi", timestamp 2 hours ago, and model "claude-sonnet-4-6"
- **WHEN** the message renders
- **THEN** the header shows: blue circle with "P", text "pi", text "2h ago", and a gray pill "claude-sonnet-4-6"

#### Scenario: Footer shows token usage
- **GIVEN** an assistant message with `usage = {input: 3100000, output: 9700}`
- **WHEN** the message renders
- **THEN** the footer line shows "3.1M in · 9.7k out"

#### Scenario: No usage hides footer
- **GIVEN** an assistant message without a `usage` field (e.g. an old session)
- **WHEN** the message renders
- **THEN** the footer is not rendered (no empty line)

#### Scenario: Large usage values
- **GIVEN** a message with `usage = {input: 1_500_000_000, output: 250_000}`
- **WHEN** the footer renders
- **THEN** it displays "1.5B in · 250.0K out"

### Requirement: Token Formatting Utility

The `formatToken(n: number)` function SHALL convert a token count to a compact string:
- n < 1000 → `${n}` (e.g. "0", "500", "999")
- n < 1,000,000 → `${(n / 1000).toFixed(1)}K` (e.g. "1.0K", "3.1K")
- n < 1,000,000,000 → `${(n / 1_000_000).toFixed(1)}M` (e.g. "1.5M", "3.1M")
- n >= 1,000,000,000 → `${(n / 1_000_000_000).toFixed(1)}B` (e.g. "1.0B", "1.5B")

The function SHALL return "0" for `NaN` or `Infinity` inputs.

#### Scenario: Small value
- **GIVEN** n = 500
- **WHEN** formatToken(500) is called
- **THEN** the result is "500"

#### Scenario: Thousands
- **GIVEN** n = 1500
- **WHEN** formatToken(1500) is called
- **THEN** the result is "1.5K"

#### Scenario: Millions
- **GIVEN** n = 3_100_000
- **WHEN** formatToken(3_100_000) is called
- **THEN** the result is "3.1M"

#### Scenario: Billions
- **GIVEN** n = 1_500_000_000
- **WHEN** formatToken(1_500_000_000) is called
- **THEN** the result is "1.5B"

#### Scenario: Edge of zero
- **GIVEN** n = 0
- **WHEN** formatToken(0) is called
- **THEN** the result is "0"

#### Scenario: NaN safety
- **GIVEN** n = NaN
- **WHEN** formatToken(NaN) is called
- **THEN** the result is "0"

### Requirement: Relative Time Formatting

The `formatRelativeTime(iso: string)` function SHALL return:
- "< 1 minute ago" → "just now"
- "< 1 hour ago" → "${minutes}m ago"
- "< 24 hours ago" → "${hours}h ago"
- "< 7 days ago" → "${days}d ago"
- ">= 7 days ago" → a date string in `Intl.DateTimeFormat` format (e.g. "Mar 5")

#### Scenario: Recent message
- **GIVEN** timestamp is 30 seconds ago
- **WHEN** formatRelativeTime is called
- **THEN** the result is "just now"

#### Scenario: Hours ago
- **GIVEN** timestamp is 2 hours ago
- **WHEN** formatRelativeTime is called
- **THEN** the result is "2h ago"

#### Scenario: Days ago
- **GIVEN** timestamp is 3 days ago
- **WHEN** formatRelativeTime is called
- **THEN** the result is "3d ago"

#### Scenario: Older than a week
- **GIVEN** timestamp is 14 days ago
- **WHEN** formatRelativeTime is called
- **THEN** the result is a date string like "May 20"

### Requirement: Server Returns Usage Per Message

The `GET /api/sessions/:id/messages` endpoint SHALL return each message with an optional `usage` field of shape `{input: number, output: number}`. The server extracts this from the JSONL entry's `message.usage` field for assistant messages.

#### Scenario: Assistant message with usage
- **GIVEN** the JSONL contains `{type:"message", message:{role:"assistant", content:[...], usage:{input:100, output:50}}}`
- **WHEN** the endpoint returns the message
- **THEN** the response object has `usage: {input: 100, output: 50}`

#### Scenario: Assistant message without usage
- **GIVEN** the JSONL contains an assistant message with no `usage` field
- **WHEN** the endpoint returns the message
- **THEN** the response object has no `usage` field (undefined, omitted in JSON)

#### Scenario: User message never has usage
- **GIVEN** the JSONL contains a user message
- **WHEN** the endpoint returns the message
- **THEN** the response object has no `usage` field (only assistant messages have usage)

### Requirement: Image Block Inline Renders With Lightbox

The webui SHALL render `ImagePart` as an inline `<img>` element using a `data:` URL with the `mediaType` and `data` fields, with `max-height: 24rem` (Tailwind `max-h-96`) to prevent a single image from filling the screen.

Multiple images in the same content array SHALL lay out horizontally in a flex-wrap container with 8px gap. Each image SHALL use `loading="lazy"`.

Clicking any inline image SHALL open a Lightbox component rendered via React Portal. The Lightbox SHALL display the full image at `max-w-[90vw] max-h-[90vh]` over a black 90% transparent backdrop. Pressing ESC or clicking the backdrop SHALL close the Lightbox.

#### Scenario: Single image renders inline
- **GIVEN** a toolResult with content `[{type:"image", mediaType:"image/png", data:"<base64>"}]`
- **WHEN** the message renders
- **THEN** an `<img src="data:image/png;base64,..." class="max-h-96 object-contain">` element is in the DOM

#### Scenario: Multiple images lay out horizontally
- **GIVEN** a toolResult with 3 images
- **WHEN** the message renders
- **THEN** the 3 images are in a horizontal flex container (flex-wrap) with 8px gap

#### Scenario: Large image is constrained
- **GIVEN** a 5MB PNG image
- **WHEN** the image renders
- **THEN** the displayed `<img>` has `max-h-96` and the page layout is not broken

#### Scenario: Click image opens lightbox
- **GIVEN** an inline image is rendered
- **WHEN** the user clicks the image
- **THEN** a Lightbox component appears as a React Portal on `document.body`
- **AND** the Lightbox shows the image at `max-w-[90vw] max-h-[90vh]` over a black 90% transparent backdrop

#### Scenario: ESC closes lightbox
- **GIVEN** the Lightbox is open
- **WHEN** the user presses the ESC key
- **THEN** the Lightbox component is removed from the DOM

#### Scenario: Backdrop click closes lightbox
- **GIVEN** the Lightbox is open
- **WHEN** the user clicks the backdrop area (outside the image)
- **THEN** the Lightbox component is removed from the DOM

#### Scenario: Lazy load large image
- **GIVEN** a base64 image larger than 1MB
- **WHEN** the image renders
- **THEN** the `<img>` element has the `loading="lazy"` attribute
