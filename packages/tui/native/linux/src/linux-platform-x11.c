#include <xcb/xcb.h>
#include <string.h>
#include <xcb/xcbext.h>
#include <errno.h>
#include <poll.h>
#include <time.h>
#include "clipboard-worker.h"

#define MAX_CLIPBOARD_BYTES (50u * 1024u * 1024u)
#define CLIPBOARD_TIMEOUT_MS 2000

static const char* const text_types[] = {
    "text/plain;charset=utf-8", "text/plain;charset=UTF-8", "UTF8_STRING", "text/plain", "STRING",
};
static const char* const image_types[] = {
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff",
};

static int64_t monotonic_ms(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

typedef struct {
    unsigned char* data;
    size_t length;
    uint32_t items;
    uint8_t format;
    xcb_atom_t type;
} property_data;

typedef struct {
    xcb_connection_t* connection;
    xcb_window_t window;
    xcb_atom_t clipboard;
    xcb_atom_t property;
    xcb_atom_t targets;
    xcb_atom_t incr;
    int64_t deadline;
} x11_clipboard;

static bool append_bytes(property_data* result, const unsigned char* bytes, size_t length) {
    if (length > MAX_CLIPBOARD_BYTES - result->length) return false;
    unsigned char* data = realloc(result->data, result->length + length + 1);
    if (!data) return false;
    memcpy(data + result->length, bytes, length);
    result->length += length;
    data[result->length] = 0;
    result->data = data;
    return true;
}

// Share one deadline across discovery, replies, and incremental chunks.
// Connection setup and flushing are libxcb calls on the private thread.
static bool wait_for_input(x11_clipboard* clipboard) {
    for (;;) {
        int64_t remaining = clipboard->deadline - monotonic_ms();
        if (remaining <= 0 || xcb_connection_has_error(clipboard->connection)) return false;
        struct pollfd descriptor = {xcb_get_file_descriptor(clipboard->connection), POLLIN, 0};
        int ready = poll(&descriptor, 1, (int)remaining);
        if (ready >= 0) return ready && (descriptor.revents & POLLIN);
        if (errno != EINTR) return false;
    }
}

static void* wait_for_reply(x11_clipboard* clipboard, unsigned sequence) {
    if (xcb_flush(clipboard->connection) <= 0) return 0;
    while (monotonic_ms() < clipboard->deadline) {
        void* reply = 0;
        xcb_generic_error_t* error = 0;
        if (xcb_poll_for_reply(clipboard->connection, sequence, &reply, &error)) {
            free(error);
            return reply;
        }
        if (!wait_for_input(clipboard)) break;
    }
    xcb_discard_reply(clipboard->connection, sequence);
    return 0;
}

static xcb_generic_event_t* wait_for_event(x11_clipboard* clipboard, uint8_t type) {
    if (xcb_flush(clipboard->connection) <= 0) return 0;
    while (monotonic_ms() < clipboard->deadline) {
        xcb_generic_event_t* event = xcb_poll_for_event(clipboard->connection);
        if (event) {
            if ((event->response_type & 0x7f) == type) return event;
            free(event);
        } else if (!wait_for_input(clipboard)) {
            break;
        }
    }
    return 0;
}

static bool read_property(x11_clipboard* clipboard, bool remove, property_data* result) {
    xcb_get_property_cookie_t cookie = xcb_get_property(
        clipboard->connection, remove, clipboard->window, clipboard->property,
        XCB_GET_PROPERTY_TYPE_ANY, 0, MAX_CLIPBOARD_BYTES / 4
    );
    xcb_get_property_reply_t* reply = wait_for_reply(clipboard, cookie.sequence);
    if (!reply) return false;
    bool copied = false;
    bool valid_format = reply->format == 8 || reply->format == 16 || reply->format == 32;
    uint64_t length = (uint64_t)reply->value_len * (reply->format / 8);
    if (reply->bytes_after == 0 && reply->type != XCB_NONE && valid_format &&
        length <= MAX_CLIPBOARD_BYTES && length <= (uint64_t)reply->length * 4) {
        result->type = reply->type;
        result->format = reply->format;
        result->items = reply->value_len;
        copied = append_bytes(result, xcb_get_property_value(reply), (size_t)length);
    }
    free(reply);
    return copied;
}

static bool append_property(property_data* result, const property_data* chunk) {
    if ((chunk->format != 8 && chunk->format != 16 && chunk->format != 32) ||
        chunk->type == XCB_NONE ||
        (uint64_t)chunk->items * (chunk->format / 8) != chunk->length ||
        (result->type != XCB_NONE && (result->type != chunk->type || result->format != chunk->format)) ||
        chunk->items > UINT32_MAX - result->items) return false;
    if (!append_bytes(result, chunk->data, chunk->length)) return false;
    result->type = chunk->type;
    result->format = chunk->format;
    result->items += chunk->items;
    return true;
}

static bool request_selection(x11_clipboard* clipboard, xcb_atom_t target, property_data* result) {
    memset(result, 0, sizeof(*result));
    xcb_delete_property(clipboard->connection, clipboard->window, clipboard->property);
    xcb_convert_selection(
        clipboard->connection, clipboard->window, clipboard->clipboard,
        target, clipboard->property, XCB_CURRENT_TIME
    );

    while (true) {
        xcb_selection_notify_event_t* event = (xcb_selection_notify_event_t*)wait_for_event(clipboard, XCB_SELECTION_NOTIFY);
        if (!event) return false;
        bool matches = event->selection == clipboard->clipboard && event->target == target;
        bool received = event->property != XCB_NONE;
        free(event);
        if (!matches) continue;
        if (!received) return true; // No owner, or the owner does not offer this target.
        if (!read_property(clipboard, false, result)) return false;
        break;
    }
    if (result->type != clipboard->incr) return true;

    free(result->data);
    memset(result, 0, sizeof(*result));
    xcb_delete_property(clipboard->connection, clipboard->window, clipboard->property);

    while (true) {
        xcb_property_notify_event_t* event = (xcb_property_notify_event_t*)wait_for_event(clipboard, XCB_PROPERTY_NOTIFY);
        if (!event) return false;
        bool matches = event->atom == clipboard->property && event->state == XCB_PROPERTY_NEW_VALUE;
        free(event);
        if (!matches) continue;

        property_data chunk = {0};
        if (!read_property(clipboard, true, &chunk)) return false;
        bool appended = append_property(result, &chunk);
        bool finished = chunk.items == 0;
        free(chunk.data);
        if (!appended) return false;
        if (finished) return true;
    }
}

static xcb_atom_t intern_atom(x11_clipboard* clipboard, const char* name) {
    xcb_intern_atom_cookie_t cookie = xcb_intern_atom(clipboard->connection, false, strlen(name), name);
    xcb_intern_atom_reply_t* reply = wait_for_reply(clipboard, cookie.sequence);
    if (!reply) return XCB_NONE;
    xcb_atom_t atom = reply->atom;
    free(reply);
    return atom;
}

static bool open_clipboard(x11_clipboard* clipboard) {
    memset(clipboard, 0, sizeof(*clipboard));
    clipboard->deadline = monotonic_ms() + CLIPBOARD_TIMEOUT_MS;
    int screen_number = 0;
    clipboard->connection = xcb_connect(0, &screen_number);
    if (xcb_connection_has_error(clipboard->connection)) return false;
    xcb_screen_iterator_t screens = xcb_setup_roots_iterator(xcb_get_setup(clipboard->connection));
    while (screen_number-- > 0 && screens.rem) xcb_screen_next(&screens);
    if (!screens.rem) return false;

    clipboard->window = xcb_generate_id(clipboard->connection);
    uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
    xcb_create_window(
        clipboard->connection, XCB_COPY_FROM_PARENT, clipboard->window,
        screens.data->root, 0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT,
        XCB_COPY_FROM_PARENT, XCB_CW_EVENT_MASK, &mask
    );
    clipboard->clipboard = intern_atom(clipboard, "CLIPBOARD");
    clipboard->property = intern_atom(clipboard, "PI_CLIPBOARD");
    clipboard->targets = intern_atom(clipboard, "TARGETS");
    clipboard->incr = intern_atom(clipboard, "INCR");
    return clipboard->clipboard && clipboard->property && clipboard->targets && clipboard->incr;
}

static void close_clipboard(x11_clipboard* clipboard) {
    if (clipboard->connection) xcb_disconnect(clipboard->connection);
}

static bool preferred_target(x11_clipboard* clipboard, bool image, xcb_atom_t* target) {
    const char* const* types = image ? image_types : text_types;
    size_t type_count = image ? 6 : 5;
    xcb_atom_t wanted[6];
    for (size_t index = 0; index < type_count; index++) {
        wanted[index] = intern_atom(clipboard, types[index]);
        if (wanted[index] == XCB_NONE) return false;
    }

    property_data targets = {0};
    bool received = request_selection(clipboard, clipboard->targets, &targets);
    bool valid = targets.type == XCB_ATOM_ATOM && targets.format == 32 &&
        targets.items == targets.length / sizeof(xcb_atom_t) && targets.length % sizeof(xcb_atom_t) == 0;
    if (received && valid) {
        xcb_atom_t* offered = (xcb_atom_t*)targets.data;
        for (size_t wanted_index = 0; wanted_index < type_count; wanted_index++) {
            for (uint32_t offered_index = 0; offered_index < targets.items; offered_index++) {
                if (offered[offered_index] == wanted[wanted_index]) {
                    free(targets.data);
                    *target = wanted[wanted_index];
                    return true;
                }
            }
        }
    }
    free(targets.data);
    // Some owners refuse TARGETS but still serve text directly.
    if (received && !image && targets.type == XCB_NONE) {
        *target = intern_atom(clipboard, "UTF8_STRING");
        return *target != XCB_NONE;
    }
    return received && (valid || targets.type == XCB_NONE);
}

static bool read_selection(x11_clipboard* clipboard, bool image, property_data* result) {
    xcb_atom_t target = XCB_NONE;
    bool received = preferred_target(clipboard, image, &target) &&
        (target == XCB_NONE || request_selection(clipboard, target, result));
    if (!received) {
        free(result->data);
        memset(result, 0, sizeof(*result));
    }
    return received;
}

static void read_clipboard(clipboard_job* job) {
    x11_clipboard clipboard;
    if (open_clipboard(&clipboard)) {
        property_data contents = {0};
        if (!read_selection(&clipboard, job->operation == CLIPBOARD_IMAGE, &contents)) {
            job->error = "Could not read X11 clipboard";
        } else {
            job->data = contents.data;
            job->length = contents.length;
            job->format = !contents.data ? CLIPBOARD_EMPTY : job->operation == CLIPBOARD_IMAGE
                ? CLIPBOARD_BUFFER : contents.type == XCB_ATOM_STRING ? CLIPBOARD_LATIN1 : CLIPBOARD_UTF8;
        }
    }
    close_clipboard(&clipboard);
}

PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "getText", get_clipboard_text);
    set_function_export(env, exports, "getImage", get_clipboard_image);
    return exports;
}
