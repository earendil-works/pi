"""RPC JSONL mode."""

from pi_mono.coding_agent.modes.rpc.jsonl import serialize_json_line
from pi_mono.coding_agent.modes.rpc.rpc_client import RpcClient, RpcClientOptions
from pi_mono.coding_agent.modes.rpc.rpc_mode import (
    RpcMode,
    build_error_response,
    build_success_response,
    parse_rpc_command,
    run_rpc_mode,
)
from pi_mono.coding_agent.modes.rpc.rpc_types import RpcCommand, RpcResponse, RpcSessionState

__all__ = [
    "RpcClient",
    "RpcClientOptions",
    "RpcCommand",
    "RpcMode",
    "RpcResponse",
    "RpcSessionState",
    "build_error_response",
    "build_success_response",
    "parse_rpc_command",
    "run_rpc_mode",
    "serialize_json_line",
]
