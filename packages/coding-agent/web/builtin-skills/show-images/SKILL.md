---
name: show-images
description: Show images in Pi web chat from internet URLs, local image files, or images read from the filesystem.
---

# Show Images

Use this skill when an answer would be clearer with an image, screenshot, diagram, generated asset, local file preview, or visual reference.

Pi web renders image references in assistant messages. To show an internet image, write a normal Markdown image:

```md
![Short description](https://example.com/image.png)
```

You can also write a direct image URL on its own line:

```text
https://example.com/image.png
```

To show an image file from the computer filesystem, use the absolute path in Markdown:

```md
![Screenshot](/Users/jota/path/to/screenshot.png)
```

Relative paths work when they are relative to the current working directory:

```md
![Preview](./artifacts/preview.png)
```

Supported local image formats are PNG, JPEG, GIF, and WebP. If you need to show a local image and inspect it first, use the `read` tool on the image path. Pi web can render image content returned by the `read` tool.

When showing images:

- Prefer concise surrounding text.
- Use meaningful alt text.
- Use absolute local paths when there is any ambiguity.
- Do not use `file://` URLs unless necessary; plain absolute paths are preferred.
- If a local image does not appear, verify the path exists and that the file is a supported image type.
