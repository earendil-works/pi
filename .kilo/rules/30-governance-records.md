# Governance records

These paths are writable by agents and are where Kilo's work becomes auditable.

| Record | Path | When |
|---|---|---|
| Session registration | `docs/agent-log/registrations/` | Substantive sessions |
| Intent log | `docs/agent-log/intent/` | Before broad, sensitive, architectural, or irreversible actions |
| Escalation | `docs/escalations/` | Blockers and decision boundaries |
| Handoff | `docs/agent-log/handoffs/` | End of significant work |
| Active threads | `docs/active-threads.md` | As work changes |

Follow the shape of the existing records in each directory rather than inventing a format.

Intent is logged **before** the action, not reconstructed afterward. A handoff states what
was actually done, what was actually verified, and what remains — not an optimistic summary.

The repository-local validator is:

```
bash .nltotoi/scripts/validate-governance.sh
```

Run it before opening a pull request that touches governance files or records.
