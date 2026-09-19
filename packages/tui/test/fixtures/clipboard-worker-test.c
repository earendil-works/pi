#include <assert.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

static atomic_int allocations, reads;
static atomic_bool released;

static void* tracked_calloc(size_t count, size_t size) {
    void* pointer = calloc(count, size);
    if (pointer) atomic_fetch_add(&allocations, 1);
    return pointer;
}

static void tracked_free(void* pointer) {
    if (pointer) atomic_fetch_sub(&allocations, 1);
    free(pointer);
}

#define calloc tracked_calloc
#define free tracked_free
#include "../../native/linux/src/clipboard-worker.h"
#undef calloc
#undef free

// Exercise the production executor with a controlled blocking callback, without X11.
static void read_clipboard(clipboard_job* job) {
    job->data = tracked_calloc(5, 1);
    assert(job->data);
    memcpy(job->data, "text", 4);
    job->length = 4;
    job->format = job->operation == CLIPBOARD_IMAGE ? CLIPBOARD_BUFFER : CLIPBOARD_UTF8;
    atomic_fetch_add(&reads, 1);
    while (!atomic_load(&released)) {
        struct timespec delay = {.tv_nsec = 1000000};
        nanosleep(&delay, 0);
    }
}

static napi_value release_reader(napi_env env, napi_callback_info info) {
    (void)info;
    atomic_store(&released, true);
    return undefined_value(env);
}

static napi_value get_state(napi_env env, napi_callback_info info) {
    (void)info;
    char state[80];
    pthread_mutex_lock(&worker_mutex);
    snprintf(state, sizeof(state), "%d,%d,%d", atomic_load(&reads), atomic_load(&allocations), worker_busy);
    pthread_mutex_unlock(&worker_mutex);
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_value result = 0;
    create_string(env, state, NAPI_AUTO_LENGTH, &result);
    return result;
}

PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "getText", get_clipboard_text);
    set_function_export(env, exports, "getImage", get_clipboard_image);
    set_function_export(env, exports, "release", release_reader);
    set_function_export(env, exports, "state", get_state);
    return exports;
}
