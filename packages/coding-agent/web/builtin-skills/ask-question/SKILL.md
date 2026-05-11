---
name: ask-question
description: Ask the user a multiple-choice question and allow a custom answer when none of the options match.
---

# Ask Question

Use this skill when you need the user to choose between a small set of options before continuing.

When `PI_WEB_ASK_QUESTION_URL` is available, ask through Pi web's native question modal. Send a POST request with JSON:

```json
{
  "question": "Which option should I use?",
  "options": ["Option A", "Option B"]
}
```

Use a portable shell command like:

```sh
curl -fsS -X POST "$PI_WEB_ASK_QUESTION_URL" \
  -H 'content-type: application/json' \
  -d '{"question":"Which option should I use?","options":["Option A","Option B"]}'
```

The response is JSON:

```json
{
  "answer": "Option A",
  "optionIndex": 0,
  "custom": false
}
```

If the user writes their own answer, `optionIndex` is `null` and `custom` is `true`.

If `PI_WEB_ASK_QUESTION_URL` is not available, ask in normal chat. Include numbered options and an `Other` option that tells the user they can write their own answer.
