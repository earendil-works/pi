import sys
import ctypes
from typing import Literal

ModifierKey = Literal["shift", "command", "control", "option"]


def is_native_modifier_pressed(key: ModifierKey) -> bool:
    """
    Check if a modifier key is physically pressed.
    Currently only supported on macOS via CoreGraphics.
    """
    if sys.platform != "darwin":
        return False

    try:
        # Load CoreGraphics. framework dynamically on macOS
        # CoreGraphics event state checks are fast and don't require process context
        cg = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")

        # CGEventFlags CGEventSourceFlagsState(CGEventSourceStateID stateID);
        cg.CGEventSourceFlagsState.argtypes = [ctypes.c_int32]
        cg.CGEventSourceFlagsState.restype = ctypes.c_uint64

        # kCGEventSourceStateCombinedSessionState = 0
        flags = cg.CGEventSourceFlagsState(0)

        # Modifiers bitmask mapping from CoreGraphics event flags
        masks = {
            "shift": 0x00020000,  # kCGEventFlagMaskShift
            "command": 0x00100000,  # kCGEventFlagMaskCommand
            "control": 0x00040000,  # kCGEventFlagMaskControl
            "option": 0x00080000,  # kCGEventFlagMaskAlternate
        }

        mask = masks.get(key)
        if mask is not None:
            return (flags & mask) != 0
    except Exception:
        pass

    return False
