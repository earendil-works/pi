#include <CoreGraphics/CoreGraphics.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef int (*napi_create_function_fn)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef int (*napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (*napi_get_boolean_fn)(napi_env, bool, napi_value*);
typedef int (*napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
typedef int (*napi_get_value_string_utf8_fn)(napi_env, napi_value, char*, size_t, size_t*);

static void* node_symbol(const char* name) {
    return dlsym(RTLD_DEFAULT, name);
}

static CGEventFlags modifier_mask_for_name(const char* name) {
    if (strcmp(name, "shift") == 0) return kCGEventFlagMaskShift;
    if (strcmp(name, "command") == 0) return kCGEventFlagMaskCommand;
    if (strcmp(name, "control") == 0) return kCGEventFlagMaskControl;
    if (strcmp(name, "option") == 0) return kCGEventFlagMaskAlternate;
    return 0;
}

static napi_value is_modifier_pressed(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");

    bool pressed = false;
    if (napi_get_cb_info && napi_get_value_string_utf8) {
        size_t argc = 1;
        napi_value args[1] = {0};
        if (napi_get_cb_info(env, info, &argc, args, 0, 0) == 0 && argc >= 1 && args[0]) {
            char name[16] = {0};
            size_t copied = 0;
            if (napi_get_value_string_utf8(env, args[0], name, sizeof(name), &copied) == 0) {
                CGEventFlags mask = modifier_mask_for_name(name);
                if (mask != 0) {
                    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
                    pressed = (flags & mask) != 0;
                }
            }
        }
    }

    napi_value result = 0;
    if (napi_get_boolean) napi_get_boolean(env, pressed, &result);
    return result;
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
    napi_set_named_property_fn napi_set_named_property = (napi_set_named_property_fn)node_symbol("napi_set_named_property");

    napi_value fn = 0;
    if (napi_create_function &&
        napi_set_named_property &&
        napi_create_function(env, "isModifierPressed", NAPI_AUTO_LENGTH, is_modifier_pressed, 0, &fn) == 0) {
        napi_set_named_property(env, exports, "isModifierPressed", fn);
    }

    return exports;
}
