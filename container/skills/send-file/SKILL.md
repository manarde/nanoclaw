---
name: send-file
description: Upload a file (PDF, image, document, etc.) to the current chat. Use when the user asks you to send a file, attach a document, or share a generated report. Currently supported on Slack; other channels error.
---

# Send a file to the chat

When the user wants a file — a PDF report, a generated chart, a document — use the `send_file` MCP tool to upload it to the current chat. You don't need any API tokens; the host does the upload using its existing platform credentials.

## How to use it

1. **Write the file under `/workspace/group/`.** That's your group's working directory and is readable by the host. Files written anywhere else cannot be uploaded.
2. **Call `send_file`** with the path, optionally a `title` and an `initial_comment`.

```
send_file(file_path="reports/q1-summary.pdf",
          title="Q1 Summary",
          initial_comment="Here's the draft — let me know what to tweak.")
```

Path can be absolute (`/workspace/group/reports/q1-summary.pdf`) or relative to the group folder (`reports/q1-summary.pdf`).

## When to use it

- User asks to "send" / "share" / "attach" a file
- You generated a report, chart, export, or other artifact worth delivering as a file rather than inline text
- A PDF or image is a more useful answer than prose (large tables, formatted documents, binary content)

## When NOT to use it

- Short text results — use `send_message` instead
- Files that exist outside `/workspace/group` (the host will reject them)
- Channels that don't support uploads — you'll get an error back. Fall back to posting a summary with `send_message`.

## Channel support

| Channel | Supported |
|---------|-----------|
| Slack   | yes |
| Telegram, WhatsApp, Discord, etc. | not yet — will return an error |

The tool does not know which channel you're in. If upload fails with a "does not support file upload" error, use `send_message` instead with a text summary.
