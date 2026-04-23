---
name: excel-reader
description: Read .xlsx / .xlsm files and get structured JSON (headers + row objects). Use when the user shares a spreadsheet, asks you to extract data from an Excel file, or references columns/rows in a workbook. Auto-installs exceljs on first use.
---

# Excel Reader

Parses Excel files (`.xlsx`, `.xlsm`) into structured JSON. Headers come from row 1; data rows are returned as key-value objects. Merged cells inherit the master value. Dates become ISO strings.

## Usage

```bash
node ~/.claude/skills/excel-reader/reader.mjs <file_path> [sheet] [--range start:end] [--limit N]
```

- `<file_path>` — path to the `.xlsx` (absolute or relative to your current dir)
- `[sheet]` — optional. Sheet name (`"Company Profiles"`) or 0-based index (`0`). Defaults to first sheet.
- `--range start:end` — optional. Read rows in this range (1-indexed spreadsheet rows, so `--range 2:500` skips the header row and reads the first 500 data rows).
- `--limit N` — optional. Max data rows to return. Default 500.

## Output

```json
{
  "file": "attendees.xlsx",
  "sheets": ["Sheet1", "Summary"],
  "active_sheet": "Sheet1",
  "headers": ["Name", "Company", "Email"],
  "total_data_rows": 1243,
  "returned_rows": 500,
  "truncated": true,
  "range": null,
  "rows": [
    { "Name": "Jane Doe", "Company": "Acme", "Email": "jane@acme.com" },
    ...
  ]
}
```

- `truncated: true` means there are more data rows than returned. Use `--range` or `--limit` to fetch the rest.
- Empty cells become `null`. Duplicate header names get `_2`, `_3`, … suffixes.

## When to use

- The user uploads / references an Excel file
- You need a specific column or row range from a workbook
- You need to count or filter entries in a spreadsheet

## Tips for large files

1. Call with no args first to see `sheets`, `headers`, and `total_data_rows` — this returns the first 500 rows.
2. If truncated, loop `--range 502:1001`, `--range 1002:1501`, … until you have the data you need. Or if you only want specific columns, note the headers and page through.
3. For multi-sheet workbooks, read each sheet separately — the active sheet's metadata is returned but only its rows.

## Errors

- Exits 1 and writes to stderr on: missing file, unknown sheet, malformed workbook, install failure.
- First run in a new container installs `exceljs` to `~/.claude/cache/excel-reader-deps/` (one-time, a few seconds). Subsequent runs are instant.
