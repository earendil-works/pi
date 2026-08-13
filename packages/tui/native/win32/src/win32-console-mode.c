#include <windows.h>

#ifndef ENABLE_VIRTUAL_TERMINAL_INPUT
#define ENABLE_VIRTUAL_TERMINAL_INPUT 0x0200
#endif

#define NAPI_AUTO_LENGTH ((unsigned long long)-1)
#define KEY_PRESSED_MASK 0x8000

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef napi_value (__cdecl *napi_callback)(napi_env, napi_callback_info);
typedef int (__cdecl *napi_create_function_fn)(napi_env, const char*, unsigned long long, napi_callback, void*, napi_value*);
typedef int (__cdecl *napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (__cdecl *napi_get_boolean_fn)(napi_env, int, napi_value*);
typedef int (__cdecl *napi_get_cb_info_fn)(napi_env, napi_callback_info, unsigned long long*, napi_value*, napi_value*, void**);
typedef int (__cdecl *napi_get_value_string_utf8_fn)(napi_env, napi_value, char*, unsigned long long, unsigned long long*);
typedef SHORT (WINAPI *get_async_key_state_fn)(int);

static void* node_symbol(const char* name) {
    HMODULE module = GetModuleHandleA(0);
    void* proc = module ? (void*)GetProcAddress(module, name) : 0;
    if (proc) return proc;

    module = GetModuleHandleA("node.dll");
    return module ? (void*)GetProcAddress(module, name) : 0;
}

static int string_equals(const char* left, const char* right) {
    while (*left && *right && *left == *right) {
        left++;
        right++;
    }
    return *left == 0 && *right == 0;
}

static get_async_key_state_fn get_async_key_state_symbol(void) {
    static int loaded = 0;
    static get_async_key_state_fn get_async_key_state = 0;

    if (!loaded) {
        HMODULE module = GetModuleHandleA("user32.dll");
        if (!module) module = LoadLibraryA("user32.dll");
        get_async_key_state = module ? (get_async_key_state_fn)GetProcAddress(module, "GetAsyncKeyState") : 0;
        loaded = 1;
    }

    return get_async_key_state;
}

static int is_key_pressed(int virtual_key) {
    get_async_key_state_fn get_async_key_state = get_async_key_state_symbol();
    return get_async_key_state && (((unsigned short)get_async_key_state(virtual_key)) & KEY_PRESSED_MASK) != 0;
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
    int enabled = handle != INVALID_HANDLE_VALUE &&
        GetConsoleMode(handle, &mode) &&
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_INPUT);

    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    napi_value result = 0;
    if (napi_get_boolean) napi_get_boolean(env, enabled, &result);
    return result;
}

static napi_value __cdecl is_modifier_pressed(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");

    int pressed = 0;
    if (napi_get_cb_info && napi_get_value_string_utf8) {
        unsigned long long argc = 1;
        napi_value args[1] = {0};
        if (napi_get_cb_info(env, info, &argc, args, 0, 0) == 0 && argc >= 1 && args[0]) {
            char name[16] = {0};
            unsigned long long copied = 0;
            if (napi_get_value_string_utf8(env, args[0], name, sizeof(name), &copied) == 0) {
                pressed = is_modifier_name_pressed(name);
            }
        }
    }

    napi_value result = 0;
    if (napi_get_boolean) napi_get_boolean(env, pressed, &result);
    return result;
}

static void set_function_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
    napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
    napi_set_named_property_fn napi_set_named_property = (napi_set_named_property_fn)node_symbol("napi_set_named_property");

    napi_value fn = 0;
    if (napi_create_function &&
        napi_set_named_property &&
        napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, 0, &fn) == 0) {
        napi_set_named_property(env, exports, name, fn);
    }
}

__declspec(dllexport) napi_value __cdecl napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "enableVirtualTerminalInput", enable_virtual_terminal_input);
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    return exports;
}
