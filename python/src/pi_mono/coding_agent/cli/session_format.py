"""Session list formatting helpers."""

from __future__ import annotations

from datetime import datetime


def format_session_date(date: datetime) -> str:
    now = datetime.now(tz=date.tzinfo)
    diff_ms = (now - date).total_seconds() * 1000
    diff_mins = int(diff_ms / 60000)
    diff_hours = int(diff_ms / 3600000)
    diff_days = int(diff_ms / 86400000)
    if diff_mins < 1:
        return "now"
    if diff_mins < 60:
        return f"{diff_mins}m"
    if diff_hours < 24:
        return f"{diff_hours}h"
    if diff_days < 7:
        return f"{diff_days}d"
    if diff_days < 30:
        return f"{diff_days // 7}w"
    if diff_days < 365:
        return f"{diff_days // 30}mo"
    return f"{diff_days // 365}y"
