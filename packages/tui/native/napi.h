#ifndef PI_NAPI_H
#define PI_NAPI_H

// Resolve the small N-API surface we use from Node or Bun, without Node headers
// or a link-time dependency on a particular runtime.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#ifdef _WIN32
#include <windows.h>
#define PI_NAPI_CALL __cdecl
#define PI_NAPI_EXPORT __declspec(dllexport)
#else
#include <dlfcn.h>
#define PI_NAPI_CALL
#define PI_NAPI_EXPORT __attribute__((visibility("default")))
#endif

#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef void* napi_async_work;
typedef void* napi_deferred;
typedef void (PI_NAPI_CALL *napi_async_execute_callback)(napi_env, void*);
typedef void (PI_NAPI_CALL *napi_async_complete_callback)(napi_env, int, void*);
typedef int (PI_NAPI_CALL *napi_create_async_work_fn)(napi_env, napi_value, napi_value, napi_async_execute_callback, napi_async_complete_callback, void*, napi_async_work*);
typedef int (PI_NAPI_CALL *napi_async_work_fn)(napi_env, napi_async_work);
typedef int (PI_NAPI_CALL *napi_create_promise_fn)(napi_env, napi_deferred*, napi_value*);
typedef int (PI_NAPI_CALL *napi_settle_deferred_fn)(napi_env, napi_deferred, napi_value);
typedef int (PI_NAPI_CALL *napi_create_error_fn)(napi_env, napi_value, napi_value, napi_value*);
typedef napi_value (PI_NAPI_CALL *napi_callback)(napi_env, napi_callback_info);
typedef int (PI_NAPI_CALL *napi_create_buffer_copy_fn)(napi_env, size_t, const void*, void**, napi_value*);
typedef int (PI_NAPI_CALL *napi_create_function_fn)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef int (PI_NAPI_CALL *napi_create_string_utf8_fn)(napi_env, const char*, size_t, napi_value*);
typedef int (PI_NAPI_CALL *napi_create_string_utf16_fn)(napi_env, const uint16_t*, size_t, napi_value*);
typedef int (PI_NAPI_CALL *napi_get_boolean_fn)(napi_env, bool, napi_value*);
typedef int (PI_NAPI_CALL *napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
typedef int (PI_NAPI_CALL *napi_get_value_fn)(napi_env, napi_value*);
typedef int (PI_NAPI_CALL *napi_get_value_string_utf8_fn)(napi_env, napi_value, char*, size_t, size_t*);
typedef int (PI_NAPI_CALL *napi_get_value_string_utf16_fn)(napi_env, napi_value, uint16_t*, size_t, size_t*);
typedef int (PI_NAPI_CALL *napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (PI_NAPI_CALL *napi_throw_error_fn)(napi_env, const char*, const char*);

static void* node_symbol(const char* name) {
#ifdef _WIN32
    HMODULE module = GetModuleHandleA(0);
    void* proc = module ? (void*)GetProcAddress(module, name) : 0;
    if (proc) return proc;
    module = GetModuleHandleA("node.dll");
    return module ? (void*)GetProcAddress(module, name) : 0;
#else
    return dlsym(RTLD_DEFAULT, name);
#endif
}

static napi_value undefined_value(napi_env env) {
    napi_get_value_fn get_value = (napi_get_value_fn)node_symbol("napi_get_undefined");
    napi_value result = 0;
    if (get_value) get_value(env, &result);
    return result;
}

static napi_value null_value(napi_env env) {
    napi_get_value_fn get_value = (napi_get_value_fn)node_symbol("napi_get_null");
    napi_value result = 0;
    if (get_value) get_value(env, &result);
    return result;
}

static napi_value fail(napi_env env, const char* message) {
    napi_throw_error_fn napi_throw_error = (napi_throw_error_fn)node_symbol("napi_throw_error");
    if (napi_throw_error) napi_throw_error(env, 0, message);
    return undefined_value(env);
}

static void set_function_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
    napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
    napi_set_named_property_fn napi_set_named_property =
        (napi_set_named_property_fn)node_symbol("napi_set_named_property");
    napi_value fn = 0;
    if (napi_create_function && napi_set_named_property &&
        napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, 0, &fn) == 0) {
        napi_set_named_property(env, exports, name, fn);
    }
}

#endif
