#ifndef PI_CLIPBOARD_H
#define PI_CLIPBOARD_H

#include "napi.h"
#ifndef _WIN32
#include <stdlib.h>
#include <string.h>
#endif

typedef enum { CLIPBOARD_TEXT, CLIPBOARD_IMAGE, CLIPBOARD_WRITE } clipboard_operation;
typedef enum { CLIPBOARD_UNAVAILABLE, CLIPBOARD_EMPTY, CLIPBOARD_UTF8, CLIPBOARD_LATIN1, CLIPBOARD_UTF16, CLIPBOARD_BUFFER } clipboard_format;

typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    clipboard_operation operation;
    clipboard_format format;
    void* data;
    size_t length;
    const char* error;
} clipboard_job;

// Only this function runs on the worker thread. It must not call N-API.
static void clipboard_execute(clipboard_job* job);

static void* clipboard_alloc(size_t size) {
#ifdef _WIN32
    return GlobalAlloc(GPTR, size);
#else
    return calloc(1, size);
#endif
}

static void clipboard_free(void* data) {
#ifdef _WIN32
    if (data) GlobalFree(data);
#else
    free(data);
#endif
}

#ifdef PI_CLIPBOARD_WRITE
static void clipboard_copy(clipboard_job* job, const void* data, size_t length, clipboard_format format) {
    job->data = clipboard_alloc(length ? length : 1);
    if (!job->data) {
        job->error = "Out of memory";
        return;
    }
#ifdef _WIN32
    volatile uint8_t* target = job->data;
    const volatile uint8_t* source = data;
    for (size_t index = 0; index < length; index++) target[index] = source[index];
#else
    memcpy(job->data, data, length);
#endif
    job->length = format == CLIPBOARD_UTF16 ? length / sizeof(uint16_t) : length;
    job->format = format;
}
#endif

static void PI_NAPI_CALL execute_clipboard_work(napi_env env, void* data) {
    (void)env;
    clipboard_execute(data);
}

static void PI_NAPI_CALL complete_clipboard_work(napi_env env, int status, void* data) {
    clipboard_job* job = data;
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_value result = undefined_value(env);
    if (status != 0) job->error = "Clipboard operation cancelled";
    if (!job->error && job->operation != CLIPBOARD_WRITE) {
        if (job->format == CLIPBOARD_EMPTY) {
            result = null_value(env);
        } else if (job->format == CLIPBOARD_BUFFER) {
            napi_create_buffer_copy_fn create_buffer = (napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
            status = create_buffer(env, job->length, job->data, 0, &result);
        } else if (job->format == CLIPBOARD_UTF16) {
            napi_create_string_utf16_fn create_utf16 = (napi_create_string_utf16_fn)node_symbol("napi_create_string_utf16");
            status = create_utf16(env, job->data, job->length, &result);
        } else if (job->format == CLIPBOARD_UTF8 || job->format == CLIPBOARD_LATIN1) {
            napi_create_string_utf8_fn create_text = job->format == CLIPBOARD_LATIN1
                ? (napi_create_string_utf8_fn)node_symbol("napi_create_string_latin1") : create_string;
            status = create_text(env, job->data, job->length, &result);
        }
        if (status != 0) job->error = "Could not create clipboard value";
    }
    if (job->error) {
        napi_create_error_fn create_error = (napi_create_error_fn)node_symbol("napi_create_error");
        napi_value message;
        create_string(env, job->error, NAPI_AUTO_LENGTH, &message);
        create_error(env, 0, message, &result);
    }
    napi_settle_deferred_fn settle = (napi_settle_deferred_fn)node_symbol(
        job->error ? "napi_reject_deferred" : "napi_resolve_deferred"
    );
    settle(env, job->deferred, result);
    napi_async_work_fn delete_work = (napi_async_work_fn)node_symbol("napi_delete_async_work");
    delete_work(env, job->work);
    clipboard_free(job->data);
    clipboard_free(job);
}

static napi_value queue_clipboard(napi_env env, napi_callback_info info, clipboard_operation operation) {
    napi_create_async_work_fn create_work = (napi_create_async_work_fn)node_symbol("napi_create_async_work");
    napi_async_work_fn queue_work = (napi_async_work_fn)node_symbol("napi_queue_async_work");
    napi_async_work_fn delete_work = (napi_async_work_fn)node_symbol("napi_delete_async_work");
    napi_create_promise_fn create_promise = (napi_create_promise_fn)node_symbol("napi_create_promise");
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    if (!create_work || !queue_work || !delete_work || !create_promise || !create_string) {
        return fail(env, "Async clipboard API unavailable");
    }
    clipboard_job* job = clipboard_alloc(sizeof(*job));
    if (!job) return fail(env, "Out of memory");
    job->operation = operation;
#ifdef PI_CLIPBOARD_WRITE
    if (operation == CLIPBOARD_WRITE) {
        napi_get_cb_info_fn get_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
#ifdef _WIN32
        napi_get_value_string_utf16_fn get_string = (napi_get_value_string_utf16_fn)node_symbol("napi_get_value_string_utf16");
        size_t unit_size = sizeof(uint16_t);
#else
        napi_get_value_string_utf8_fn get_string = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
        size_t unit_size = 1;
#endif
        size_t argc = 1;
        napi_value argument = 0;
        if (!get_info || !get_string || get_info(env, info, &argc, &argument, 0, 0) != 0 || argc == 0 ||
            get_string(env, argument, 0, 0, &job->length) != 0) {
            clipboard_free(job);
            return fail(env, "setText requires a string");
        }
        job->data = job->length < SIZE_MAX / unit_size
            ? clipboard_alloc((job->length + 1) * unit_size) : 0;
        if (!job->data || get_string(env, argument, job->data, job->length + 1, &job->length) != 0) {
            clipboard_free(job->data);
            clipboard_free(job);
            return fail(env, "Could not read clipboard text");
        }
    }
#else
    (void)info;
#endif
    napi_value name = 0;
    napi_value promise = 0;
    if (create_string(env, "pi.clipboard", NAPI_AUTO_LENGTH, &name) != 0 ||
        create_work(env, 0, name, execute_clipboard_work, complete_clipboard_work, job, &job->work) != 0 ||
        create_promise(env, &job->deferred, &promise) != 0 || queue_work(env, job->work) != 0) {
        if (job->work) delete_work(env, job->work);
        clipboard_free(job->data);
        clipboard_free(job);
        return fail(env, "Could not queue clipboard operation");
    }
    return promise;
}

static napi_value PI_NAPI_CALL get_clipboard_text(napi_env env, napi_callback_info info) {
    return queue_clipboard(env, info, CLIPBOARD_TEXT);
}

static napi_value PI_NAPI_CALL get_clipboard_image(napi_env env, napi_callback_info info) {
    return queue_clipboard(env, info, CLIPBOARD_IMAGE);
}

#ifdef PI_CLIPBOARD_WRITE
static napi_value PI_NAPI_CALL set_clipboard_text(napi_env env, napi_callback_info info) {
    return queue_clipboard(env, info, CLIPBOARD_WRITE);
}
#endif

#endif
