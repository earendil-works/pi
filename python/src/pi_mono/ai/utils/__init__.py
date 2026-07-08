"""AI utilities package."""

from pi_mono.ai.utils.diagnostics import (
    AssistantMessageDiagnostic,
    DiagnosticErrorInfo,
    append_assistant_message_diagnostic,
    create_assistant_message_diagnostic,
    extract_diagnostic_error,
    format_thrown_value,
)

from pi_mono.ai.utils.event_stream import (
    AssistantMessageEventStream,
    EventStream,
    create_assistant_message_event_stream,
)

from pi_mono.ai.utils.hash import short_hash
from pi_mono.ai.utils.headers import headers_to_record
from pi_mono.ai.utils.json_parse import (
    parse_json_with_repair,
    parse_streaming_json,
    repair_json,
)
from pi_mono.ai.utils.node_http_proxy import (
    ProxyAgents,
    create_http_proxy_agents_for_target,
    get_proxy_dict_for_requests,
    resolve_http_proxy_url_for_target,
)
from pi_mono.ai.utils.overflow import (
    get_overflow_patterns,
    is_context_overflow,
)
from pi_mono.ai.utils.sanitize_unicode import sanitize_surrogates, sanitize_unicode_for_json
from pi_mono.ai.utils.typebox_helpers import (
    array_schema,
    number_enum,
    object_schema,
    string_enum,
)
from pi_mono.ai.utils.validation import (
    Tool,
    ToolCall,
    coerce_with_json_schema,
    validate_tool_arguments,
    validate_tool_call,
)

__all__ = [
    "AssistantMessageDiagnostic",
    "DiagnosticErrorInfo",
    "append_assistant_message_diagnostic",
    "create_assistant_message_diagnostic",
    "extract_diagnostic_error",
    "format_thrown_value",
    "AssistantMessageEventStream",
    "EventStream",
    "create_assistant_message_event_stream",
    "short_hash",
    "headers_to_record",
    "parse_json_with_repair",
    "parse_streaming_json",
    "repair_json",
    "ProxyAgents",
    "create_http_proxy_agents_for_target",
    "get_proxy_dict_for_requests",
    "resolve_http_proxy_url_for_target",
    "get_overflow_patterns",
    "is_context_overflow",
    "sanitize_surrogates",
    "sanitize_unicode_for_json",
    "string_enum",
    "number_enum",
    "object_schema",
    "array_schema",
    "Tool",
    "ToolCall",
    "coerce_with_json_schema",
    "validate_tool_arguments",
    "validate_tool_call",
]
