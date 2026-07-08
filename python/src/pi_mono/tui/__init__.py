"""TUI (Terminal User Interface) package for pi-mono.

Ported from TypeScript's packages/tui/src/index.ts
"""

# Core TUI interfaces and classes
from .tui import (
    Component,
    Container,
    CURSOR_MARKER,
    Focusable,
    is_focusable,
    OverlayAnchor,
    OverlayHandle,
    OverlayMargin,
    OverlayOptions,
    OverlayUnfocusOptions,
    SizeValue,
    TUI,
)

# Editor component interface
from .editor_component import EditorComponent, BaseEditorComponent

# Terminal image support
from .terminal_image import (
    allocate_image_id,
    calculate_image_cell_size,
    calculate_image_rows,
    CellDimensions,
    delete_all_kitty_images,
    delete_kitty_image,
    detect_capabilities,
    encode_iterm2,
    encode_kitty,
    get_capabilities,
    get_cell_dimensions,
    get_gif_dimensions,
    get_image_dimensions,
    get_jpeg_dimensions,
    get_png_dimensions,
    get_webp_dimensions,
    hyperlink,
    ImageCellSize,
    ImageDimensions,
    ImageProtocol,
    ImageRenderOptions,
    image_fallback,
    is_image_line,
    render_image,
    reset_capabilities_cache,
    set_capabilities,
    set_cell_dimensions,
    TerminalCapabilities,
)

# Utilities
from .utils import (
    ActiveHyperlink,
    AnsiCodeTracker,
    apply_background_to_line,
    extract_ansi_code,
    extract_segments,
    grapheme_width,
    is_punctuation_char,
    is_whitespace_char,
    normalize_terminal_output,
    PUNCTUATION_REGEX,
    slice_by_column,
    slice_with_width,
    truncate_to_width,
    visible_width,
    wrap_text_with_ansi,
)

# Autocomplete (placeholder - will be ported separately)
# from .autocomplete import AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions, CombinedAutocompleteProvider, SlashCommand

__all__ = [
    # Core TUI
    "Component",
    "Container",
    "CURSOR_MARKER",
    "Focusable",
    "is_focusable",
    "OverlayAnchor",
    "OverlayHandle",
    "OverlayMargin",
    "OverlayOptions",
    "OverlayUnfocusOptions",
    "SizeValue",
    "TUI",
    # Editor component
    "EditorComponent",
    "BaseEditorComponent",
    # Terminal image
    "allocate_image_id",
    "calculate_image_cell_size",
    "calculate_image_rows",
    "CellDimensions",
    "delete_all_kitty_images",
    "delete_kitty_image",
    "detect_capabilities",
    "encode_iterm2",
    "encode_kitty",
    "get_capabilities",
    "get_cell_dimensions",
    "get_gif_dimensions",
    "get_image_dimensions",
    "get_jpeg_dimensions",
    "get_png_dimensions",
    "get_webp_dimensions",
    "hyperlink",
    "ImageCellSize",
    "ImageDimensions",
    "ImageProtocol",
    "ImageRenderOptions",
    "image_fallback",
    "is_image_line",
    "render_image",
    "reset_capabilities_cache",
    "set_capabilities",
    "set_cell_dimensions",
    "TerminalCapabilities",
    # Utilities
    "ActiveHyperlink",
    "AnsiCodeTracker",
    "apply_background_to_line",
    "extract_ansi_code",
    "extract_segments",
    "grapheme_width",
    "is_punctuation_char",
    "is_whitespace_char",
    "normalize_terminal_output",
    "PUNCTUATION_REGEX",
    "slice_by_column",
    "slice_with_width",
    "truncate_to_width",
    "visible_width",
    "wrap_text_with_ansi",
]
