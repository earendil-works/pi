# chat-image-input Specification

## ADDED Requirements

### Requirement: Image Input via Paperclip Button

The InputArea SHALL display a Paperclip (📎) button on the left side of the text input. Clicking the button SHALL open a hidden `<input type="file" accept="image/png,image/jpeg,image/gif,image/webp">` element. Selecting one or more valid images SHALL add them to the input image preview.

#### Scenario: Open file picker via button
- **GIVEN** the user is on a chat page with the InputArea visible
- **WHEN** the user clicks the Paperclip button
- **THEN** the system file picker opens
- **AND** the picker filters to image MIME types only

#### Scenario: Valid PNG adds to preview
- **GIVEN** the user selects `screenshot.png` (image/png, 2MB) via the file picker
- **WHEN** the file is read
- **THEN** an `InputImage` is created with `mediaType: "image/png"`, `dataUrl: "data:image/png;base64,..."`, `size: 2097152`
- **AND** the ImagePreview shows an 80×80 thumbnail

### Requirement: Image Input via Drag and Drop

The InputArea SHALL listen for `dragover`, `dragleave`, and `drop` events on the textarea region. While a file is being dragged over the area, the region SHALL display a blue dashed border highlight. Dropping one or more image files SHALL add them to the preview after validation.

#### Scenario: Drag image over textarea
- **GIVEN** the user is dragging a `diagram.jpg` file from the system file manager
- **WHEN** the file enters the InputArea region
- **THEN** the region shows a blue dashed border (`border-blue-500 border-dashed`)

#### Scenario: Drop image adds to preview
- **GIVEN** the user is dragging `diagram.jpg` (1.5MB, image/jpeg) over the InputArea
- **WHEN** the user releases the mouse
- **THEN** the image is added to the ImagePreview
- **AND** the blue dashed border is removed

#### Scenario: Drop non-image file
- **GIVEN** the user drops a `document.pdf` file
- **WHEN** the drop event is processed
- **THEN** no image is added to the preview
- **AND** an alert toast appears with text "Unsupported file type, only images"

### Requirement: Image Input via Clipboard Paste

The InputArea SHALL register a global `paste` event listener. When a paste event contains image data in the clipboard (e.g. from a screenshot tool), the image SHALL be added to the preview.

#### Scenario: Paste image from clipboard
- **GIVEN** the system clipboard contains a PNG screenshot (e.g. from macOS Preview)
- **WHEN** the user presses Cmd+V (or Ctrl+V)
- **THEN** the image is added to the ImagePreview
- **AND** no text is added to the input (only images are extracted from clipboard)

### Requirement: Image Validation

The `validateImageFile(file, currentTotal, currentCount)` function SHALL accept only files matching the following criteria:
- MIME type in `["image/png", "image/jpeg", "image/gif", "image/webp"]`
- File size <= 5MB
- Image count < 4 (so 4th image is allowed)
- Total size of current images + new file <= 20MB

If any check fails, the function SHALL return `{ok: false, reason: "type" | "size" | "count" | "total"}` and the caller SHALL display a corresponding alert.

#### Scenario: Unsupported MIME rejected
- **GIVEN** the user tries to add a `photo.bmp` (image/bmp)
- **WHEN** validateImageFile is called
- **THEN** the result is `{ok: false, reason: "type"}`
- **AND** the user sees "Unsupported image type"

#### Scenario: Oversized image rejected
- **GIVEN** the user tries to add `huge.png` (8MB)
- **WHEN** validateImageFile is called
- **THEN** the result is `{ok: false, reason: "size"}`
- **AND** the user sees "Image too large, max 5MB"

#### Scenario: Fourth image rejected
- **GIVEN** the preview already has 4 images
- **WHEN** the user tries to add a 5th image
- **THEN** the result is `{ok: false, reason: "count"}`
- **AND** the user sees "Max 4 images per message"

#### Scenario: Total size exceeded
- **GIVEN** the preview has 3 images totaling 18MB
- **WHEN** the user tries to add a 3MB image
- **THEN** the result is `{ok: false, reason: "total"}`
- **AND** the user sees "Total image size exceeds 20MB"

### Requirement: Image Preview With Remove

The ImagePreview SHALL display each image as an 80×80 rounded thumbnail with the image content (`object-cover`). Each thumbnail SHALL have a small "×" button in the top-right corner (black 50% background) that removes the image from the preview on click.

#### Scenario: Preview thumbnails render
- **GIVEN** the preview has 2 InputImages
- **WHEN** the ImagePreview renders
- **THEN** 2 thumbnails are shown side by side with 8px gap
- **AND** each thumbnail displays the image content

#### Scenario: Remove image
- **GIVEN** the preview has 2 images
- **WHEN** the user clicks the "×" on the first image
- **THEN** the first image is removed from the preview
- **AND** the second image remains

### Requirement: Send Prompt With Images

When the user submits the input form (presses Enter or clicks Send), the browser SHALL construct a WebSocket `prompt` message with:
- `text`: the input text
- `images`: an array of `{mediaType, data}` (base64 string with no prefix) for each input image

The browser SHALL also optimistically render a user message in the chat containing the text and a 40×40 thumbnail row of the input images. The input text and previews SHALL be cleared after submission.

#### Scenario: Send text only
- **GIVEN** the input has "hello world" and no images
- **WHEN** the user presses Enter
- **THEN** the WebSocket sends `{type:"prompt", text:"hello world", sessionId}` (no images field)
- **AND** the input is cleared

#### Scenario: Send text with one image
- **GIVEN** the input has "look at this" and 1 image (PNG, 2MB)
- **WHEN** the user presses Enter
- **THEN** the WebSocket sends `{type:"prompt", text:"look at this", images:[{mediaType:"image/png", data:"<base64>"}], sessionId}`
- **AND** the user message in the chat shows the text and a 40×40 thumbnail above it
- **AND** the input text and image preview are cleared

#### Scenario: Send text with multiple images
- **GIVEN** the input has "compare these" and 3 images
- **WHEN** the user presses Enter
- **THEN** the WebSocket sends `{type:"prompt", text:"compare these", images:[<3 images>], sessionId}`

#### Scenario: Shift+Enter inserts newline
- **GIVEN** the input has "line 1"
- **WHEN** the user presses Shift+Enter
- **THEN** a newline is added to the input text and no message is sent
