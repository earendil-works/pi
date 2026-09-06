#define PI_CLIPBOARD_WRITE
#include "../../clipboard.h"

#ifndef BI_ALPHABITFIELDS
#define BI_ALPHABITFIELDS 6
#endif

#define KEY_PRESSED_MASK 0x8000
#define OPEN_CLIPBOARD_ATTEMPTS 10
#define OPEN_CLIPBOARD_RETRY_MS 5
#define BITMAP_FILE_HEADER_SIZE 14

static int string_equals(const char* left, const char* right) {
    while (*left && *right && *left == *right) {
        left++;
        right++;
    }
    return *left == 0 && *right == 0;
}

static int is_key_pressed(int virtual_key) {
    return ((unsigned short)GetAsyncKeyState(virtual_key) & KEY_PRESSED_MASK) != 0;
}

static int is_modifier_name_pressed(const char* name) {
    if (string_equals(name, "shift")) return is_key_pressed(VK_SHIFT) || is_key_pressed(VK_LSHIFT) || is_key_pressed(VK_RSHIFT);
    if (string_equals(name, "control")) return is_key_pressed(VK_CONTROL) || is_key_pressed(VK_LCONTROL) || is_key_pressed(VK_RCONTROL);
    if (string_equals(name, "option") || string_equals(name, "alt")) return is_key_pressed(VK_MENU) || is_key_pressed(VK_LMENU) || is_key_pressed(VK_RMENU);
    if (string_equals(name, "command") || string_equals(name, "super") || string_equals(name, "win")) return is_key_pressed(VK_LWIN) || is_key_pressed(VK_RWIN);
    return 0;
}

static napi_value __cdecl enable_virtual_terminal_input(napi_env env, napi_callback_info info) {
    (void)info;

    HANDLE handle = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode = 0;
    bool enabled = handle != INVALID_HANDLE_VALUE &&
        GetConsoleMode(handle, &mode) &&
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_INPUT);

    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, enabled, &result) != 0) {
        return fail(env, "Could not configure console input");
    }
    return result;
}

static napi_value __cdecl is_modifier_pressed(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 =
        (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");

    bool pressed = false;
    if (napi_get_cb_info && napi_get_value_string_utf8) {
        size_t argc = 1;
        napi_value args[1] = {0};
        if (napi_get_cb_info(env, info, &argc, args, 0, 0) == 0 && argc >= 1 && args[0]) {
            char name[16] = {0};
            size_t copied = 0;
            if (napi_get_value_string_utf8(env, args[0], name, sizeof(name), &copied) == 0) {
                pressed = is_modifier_name_pressed(name);
            }
        }
    }

    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, pressed, &result) != 0) {
        return fail(env, "Could not inspect modifier state");
    }
    return result;
}

static bool open_clipboard(HWND owner) {
    for (int attempt = 0; attempt < OPEN_CLIPBOARD_ATTEMPTS; attempt++) {
        if (OpenClipboard(owner)) return true;
        Sleep(OPEN_CLIPBOARD_RETRY_MS);
    }
    return false;
}

static uint16_t read_u16(const uint8_t* data) {
    return (uint16_t)data[0] | ((uint16_t)data[1] << 8);
}

static uint32_t read_u32(const uint8_t* data) {
    return (uint32_t)data[0] |
        ((uint32_t)data[1] << 8) |
        ((uint32_t)data[2] << 16) |
        ((uint32_t)data[3] << 24);
}

static void write_u32(uint8_t* data, uint32_t value) {
    data[0] = (uint8_t)value;
    data[1] = (uint8_t)(value >> 8);
    data[2] = (uint8_t)(value >> 16);
    data[3] = (uint8_t)(value >> 24);
}

static void copy_bytes(uint8_t* destination, const uint8_t* source, size_t length) {
    volatile uint8_t* target = destination;
    const volatile uint8_t* input = source;
    for (size_t index = 0; index < length; index++) target[index] = input[index];
}

static size_t dib_pixel_offset(const uint8_t* dib, size_t size) {
    if (size < 12) return 0;
    uint32_t header_size = read_u32(dib);

    if (header_size == 12) {
        uint16_t bits_per_pixel = read_u16(dib + 10);
        uint32_t color_count = bits_per_pixel <= 8 ? 1u << bits_per_pixel : 0;
        size_t offset = header_size + (size_t)color_count * 3;
        return offset <= size ? offset : 0;
    }

    if (header_size < 40 || header_size > size) return 0;
    uint16_t bits_per_pixel = read_u16(dib + 14);
    uint32_t compression = read_u32(dib + 16);
    uint32_t color_count = read_u32(dib + 32);
    if (!color_count && bits_per_pixel <= 8) color_count = 1u << bits_per_pixel;

    size_t offset = header_size + (size_t)color_count * 4;
    if (header_size == 40 && compression == BI_BITFIELDS) offset += 3 * sizeof(uint32_t);
    if (header_size == 40 && compression == BI_ALPHABITFIELDS) offset += 4 * sizeof(uint32_t);
    return offset <= size ? offset : 0;
}

static void read_clipboard_image(clipboard_job* job) {
    UINT png_format = RegisterClipboardFormatW(L"PNG");
    if (!(png_format && IsClipboardFormatAvailable(png_format)) &&
        !IsClipboardFormatAvailable(CF_DIBV5) && !IsClipboardFormatAvailable(CF_DIB)) {
        job->format = CLIPBOARD_EMPTY;
        return;
    }
    HGLOBAL handle = png_format && IsClipboardFormatAvailable(png_format)
        ? (HGLOBAL)GetClipboardData(png_format) : 0;
    bool is_png = handle != 0;
    if (!handle && IsClipboardFormatAvailable(CF_DIBV5)) handle = (HGLOBAL)GetClipboardData(CF_DIBV5);
    if (!handle && IsClipboardFormatAvailable(CF_DIB)) handle = (HGLOBAL)GetClipboardData(CF_DIB);

    const uint8_t* source = handle ? (const uint8_t*)GlobalLock(handle) : 0;
    size_t size = handle ? GlobalSize(handle) : 0;
    if (!source || !size) {
        if (source) GlobalUnlock(handle);
        job->error = "Clipboard does not contain an image";
        return;
    }
    if (is_png) {
        clipboard_copy(job, source, size, CLIPBOARD_BUFFER);
    } else {
        size_t offset = dib_pixel_offset(source, size);
        uint8_t* bitmap = offset && size <= UINT32_MAX - BITMAP_FILE_HEADER_SIZE
            ? clipboard_alloc(size + BITMAP_FILE_HEADER_SIZE) : 0;
        if (bitmap) {
            bitmap[0] = 'B';
            bitmap[1] = 'M';
            write_u32(bitmap + 2, (uint32_t)(size + BITMAP_FILE_HEADER_SIZE));
            write_u32(bitmap + 10, (uint32_t)(BITMAP_FILE_HEADER_SIZE + offset));
            copy_bytes(bitmap + BITMAP_FILE_HEADER_SIZE, source, size);
            job->data = bitmap;
            job->length = size + BITMAP_FILE_HEADER_SIZE;
            job->format = CLIPBOARD_BUFFER;
        } else {
            job->error = "Could not create clipboard image buffer";
        }
    }
    GlobalUnlock(handle);
}

static void clipboard_execute(clipboard_job* job) {
    // A real clipboard owner is required for text writes, including under Node
    // without a console. Create and destroy it on the same worker thread.
    HWND owner = 0;
    if (job->operation == CLIPBOARD_WRITE) {
        owner = CreateWindowExW(0, L"STATIC", 0, 0, 0, 0, 0, 0,
            HWND_MESSAGE, 0, GetModuleHandleA(0), 0);
        if (!owner) {
            job->error = "Could not create clipboard owner window";
            return;
        }
    }
    if (!open_clipboard(owner)) {
        if (owner) DestroyWindow(owner);
        job->error = "Could not open clipboard";
        return;
    }
    if (job->operation == CLIPBOARD_WRITE) {
        size_t size = (job->length + 1) * sizeof(uint16_t);
        HGLOBAL handle = GlobalAlloc(GMEM_MOVEABLE, size);
        void* text = handle ? GlobalLock(handle) : 0;
        bool success = false;
        if (text) {
            copy_bytes(text, job->data, size);
            GlobalUnlock(handle);
            success = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, handle) != 0;
        }
        if (!success) {
            if (handle) GlobalFree(handle);
            job->error = "Could not set clipboard text";
        }
    } else if (job->operation == CLIPBOARD_TEXT) {
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) {
            job->format = CLIPBOARD_EMPTY;
        } else {
            HGLOBAL handle = (HGLOBAL)GetClipboardData(CF_UNICODETEXT);
            const uint16_t* text = handle ? GlobalLock(handle) : 0;
            if (text) {
                size_t capacity = GlobalSize(handle) / sizeof(uint16_t);
                size_t length = 0;
                while (length < capacity && text[length]) length++;
                clipboard_copy(job, text, length * sizeof(uint16_t), CLIPBOARD_UTF16);
                GlobalUnlock(handle);
            } else {
                job->error = "Clipboard does not contain text";
            }
        }
    } else {
        read_clipboard_image(job);
    }
    CloseClipboard();
    if (owner) DestroyWindow(owner);
}

BOOL WINAPI _DllMainCRTStartup(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reason;
    (void)reserved;
    return TRUE;
}

PI_NAPI_EXPORT napi_value PI_NAPI_CALL napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "enableVirtualTerminalInput", enable_virtual_terminal_input);
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    set_function_export(env, exports, "getText", get_clipboard_text);
    set_function_export(env, exports, "setText", set_clipboard_text);
    set_function_export(env, exports, "getImage", get_clipboard_image);
    return exports;
}
