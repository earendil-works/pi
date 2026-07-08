import os
from typing import Optional, Protocol


class SessionCwdSource(Protocol):
    def get_cwd(self) -> str: ...
    def get_session_file(self) -> Optional[str]: ...


class SessionCwdIssue:
    def __init__(self, session_file: Optional[str], session_cwd: str, fallback_cwd: str):
        self.sessionFile = session_file
        self.sessionCwd = session_cwd
        self.fallbackCwd = fallback_cwd


class MissingSessionCwdError(Exception):
    def __init__(self, issue: SessionCwdIssue):
        self.issue = issue
        message = format_missing_session_cwd_error(issue)
        super().__init__(message)


def get_missing_session_cwd_issue(
    session_manager: SessionCwdSource,
    fallback_cwd: str,
) -> Optional[SessionCwdIssue]:
    session_file = session_manager.get_session_file()
    if not session_file:
        return None

    session_cwd = session_manager.get_cwd()
    if not session_cwd or os.path.exists(session_cwd):
        return None

    return SessionCwdIssue(
        session_file=session_file,
        session_cwd=session_cwd,
        fallback_cwd=fallback_cwd,
    )


def format_missing_session_cwd_error(issue: SessionCwdIssue) -> str:
    session_file_str = f"\nSession file: {issue.sessionFile}" if issue.sessionFile else ""
    return (
        f"Stored session working directory does not exist: {issue.sessionCwd}{session_file_str}\n"
        f"Current working directory: {issue.fallbackCwd}"
    )


def format_missing_session_cwd_prompt(issue: SessionCwdIssue) -> str:
    return (
        f"cwd from session file does not exist\n{issue.sessionCwd}\n\n"
        f"continue in current cwd\n{issue.fallbackCwd}"
    )


def assert_session_cwd_exists(session_manager: SessionCwdSource, fallback_cwd: str) -> None:
    issue = get_missing_session_cwd_issue(session_manager, fallback_cwd)
    if issue:
        raise MissingSessionCwdError(issue)
