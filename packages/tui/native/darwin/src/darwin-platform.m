#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <stdlib.h>
#include <string.h>
#define PI_CLIPBOARD_WRITE
#include "../../clipboard.h"

static CGEventFlags modifier_mask_for_name(const char* name) {
    if (strcmp(name, "shift") == 0) return kCGEventFlagMaskShift;
    if (strcmp(name, "command") == 0) return kCGEventFlagMaskCommand;
    if (strcmp(name, "control") == 0) return kCGEventFlagMaskControl;
    if (strcmp(name, "option") == 0) return kCGEventFlagMaskAlternate;
    return 0;
}

static napi_value is_modifier_pressed(napi_env env, napi_callback_info info) {
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
                CGEventFlags mask = modifier_mask_for_name(name);
                if (mask != 0) {
                    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
                    pressed = (flags & mask) != 0;
                }
            }
        }
    }

    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, pressed, &result) != 0) {
        return fail(env, "Could not inspect modifier state");
    }
    return result;
}

static void clipboard_execute(clipboard_job* job) {
    @autoreleasepool {
        NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
        if (!pasteboard) {
            job->error = "Could not open clipboard";
        } else if (job->operation == CLIPBOARD_WRITE) {
            NSString* text = [[NSString alloc] initWithBytes:job->data length:job->length encoding:NSUTF8StringEncoding];
            if (!text) {
                job->error = "Clipboard text is not valid UTF-8";
                return;
            }
            [pasteboard clearContents];
            if (![pasteboard setString:text forType:NSPasteboardTypeString]) job->error = "Could not set clipboard text";
        } else if (job->operation == CLIPBOARD_TEXT) {
            NSString* text = [pasteboard stringForType:NSPasteboardTypeString];
            if (!text) {
                job->format = CLIPBOARD_EMPTY;
            } else if (!text.UTF8String) {
                job->error = "Could not encode clipboard text";
            } else {
                clipboard_copy(job, text.UTF8String, [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding], CLIPBOARD_UTF8);
            }
        } else {
            if (![pasteboard availableTypeFromArray:@[ NSPasteboardTypePNG, NSPasteboardTypeTIFF ]]) {
                job->format = CLIPBOARD_EMPTY;
                return;
            }
            NSData* png = [pasteboard dataForType:NSPasteboardTypePNG];
            if (!png) {
                NSImage* image = [[NSImage alloc] initWithPasteboard:pasteboard];
                NSData* tiff = image.TIFFRepresentation;
                NSBitmapImageRep* bitmap = tiff ? [NSBitmapImageRep imageRepWithData:tiff] : nil;
                png = bitmap ? [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
            }
            if (png) clipboard_copy(job, png.bytes, png.length, CLIPBOARD_BUFFER);
            else job->error = "Clipboard does not contain an image";
        }
    }
}

PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    set_function_export(env, exports, "getText", get_clipboard_text);
    set_function_export(env, exports, "setText", set_clipboard_text);
    set_function_export(env, exports, "getImage", get_clipboard_image);
    return exports;
}
