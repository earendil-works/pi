import os
import json
from datetime import datetime, date

gemini_dir = os.path.expanduser("~/.gemini/tmp")
today = date.today().isoformat()

stats = {
    "historical": {"input": 0, "output": 0, "cached": 0, "thoughts": 0, "total": 0, "sessions": 0},
    "today": {"input": 0, "output": 0, "cached": 0, "thoughts": 0, "total": 0, "sessions": 0}
}

for root, dirs, files in os.walk(gemini_dir):
    if "chats" in root:
        for file in files:
            if file.endswith(".json"):
                is_today = file.startswith(f"session-{today}")
                category = "today" if is_today else "historical"
                stats[category]["sessions"] += 1
                
                with open(os.path.join(root, file), 'r') as f:
                    try:
                        data = json.load(f)
                        for msg in data.get("messages", []):
                            tokens = msg.get("tokens")
                            if tokens:
                                stats[category]["input"] += tokens.get("input", 0)
                                stats[category]["output"] += tokens.get("output", 0)
                                stats[category]["cached"] += tokens.get("cached", 0)
                                stats[category]["thoughts"] += tokens.get("thoughts", 0)
                                stats[category]["total"] += tokens.get("total", 0)
                    except Exception:
                        pass

def print_stats(name, s):
    print(f"--- {name.upper()} ---")
    print(f"Sessions: {s['sessions']}")
    print(f"Input Tokens: {s['input']:,}")
    print(f"Output Tokens: {s['output']:,}")
    print(f"Cached Tokens: {s['cached']:,}")
    print(f"Thought Tokens: {s['thoughts']:,}")
    print(f"Total Tokens: {s['total']:,}")
    print()

print_stats("Today's Usage", stats["today"])
print_stats("Historical Usage", stats["historical"])
