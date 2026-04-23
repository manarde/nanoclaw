#!/usr/bin/env node
// Excel reader for NanoClaw agents.
// Usage: reader.mjs <file_path> [sheet] [--range start:end]
// Emits JSON to stdout; errors to stderr + exit 1.

import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_ROW_LIMIT = 500;
const CACHE_DIR = path.join(
  process.env.HOME || '/home/node',
  '.claude',
  'cache',
  'excel-reader-deps',
);

function die(msg) {
  process.stderr.write(`excel-reader: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  let range = null;
  let limit = DEFAULT_ROW_LIMIT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--range') {
      const v = argv[++i];
      if (!v || !/^\d+:\d+$/.test(v)) die('--range must be start:end (1-indexed rows)');
      const [s, e] = v.split(':').map(Number);
      if (s < 1 || e < s) die('--range: start must be >=1 and <= end');
      range = { start: s, end: e };
    } else if (a === '--limit') {
      limit = parseInt(argv[++i], 10);
      if (!Number.isFinite(limit) || limit < 1) die('--limit must be a positive integer');
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: reader.mjs <file_path> [sheet] [--range start:end] [--limit N]\n',
      );
      process.exit(0);
    } else {
      positional.push(a);
    }
  }
  return { positional, range, limit };
}

function loadExcelJS() {
  const candidateDirs = [
    path.dirname(new URL(import.meta.url).pathname),
    process.cwd(),
    CACHE_DIR,
  ];
  for (const dir of candidateDirs) {
    try {
      const req = createRequire(path.join(dir, 'package.json'));
      return req('exceljs');
    } catch {
      // fall through
    }
  }
  // Try a bare import against the global module resolution last
  try {
    const req = createRequire(import.meta.url);
    return req('exceljs');
  } catch {
    return null;
  }
}

function installExcelJS() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const pkgJson = path.join(CACHE_DIR, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'excel-reader-deps', private: true }));
  }
  process.stderr.write('excel-reader: installing exceljs (one-time)...\n');
  const res = spawnSync(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', '--silent', 'exceljs@4'],
    { cwd: CACHE_DIR, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (res.status !== 0) die('failed to install exceljs — check container network');
}

function normalizeValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    // exceljs wraps rich text, hyperlinks, formulas, errors.
    if ('text' in v) return v.text;
    if ('result' in v) return normalizeValue(v.result);
    if ('richText' in v && Array.isArray(v.richText))
      return v.richText.map((r) => r.text).join('');
    if ('hyperlink' in v) return v.hyperlink;
    if ('error' in v) return `#${v.error}`;
    // Fallback: stringify
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

function dedupeHeaders(raw) {
  const seen = new Map();
  return raw.map((h, i) => {
    let name = h == null || String(h).trim() === '' ? `col_${i + 1}` : String(h).trim();
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name}_${count + 1}`;
  });
}

// Build a lookup of merged-cell master values so sub-cells inherit the master's value.
function buildMergedLookup(worksheet) {
  const merges = worksheet.model?.merges || [];
  const map = new Map(); // "row,col" -> value
  for (const range of merges) {
    // exceljs exposes ranges as "A1:B2" strings on .model.merges
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!m) continue;
    const colFromLetters = (letters) => {
      let n = 0;
      for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
      return n;
    };
    const r1 = parseInt(m[2], 10);
    const c1 = colFromLetters(m[1]);
    const r2 = parseInt(m[4], 10);
    const c2 = colFromLetters(m[3]);
    const masterValue = worksheet.getCell(r1, c1).value;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue;
        map.set(`${r},${c}`, masterValue);
      }
    }
  }
  return map;
}

function cellValue(worksheet, mergedLookup, row, col) {
  const cell = worksheet.getCell(row, col);
  let v = cell.value;
  if ((v == null || v === '') && mergedLookup.has(`${row},${col}`)) {
    v = mergedLookup.get(`${row},${col}`);
  }
  return normalizeValue(v);
}

async function main() {
  const { positional, range, limit } = parseArgs(process.argv.slice(2));
  if (positional.length < 1) die('usage: reader.mjs <file_path> [sheet] [--range start:end]');
  const filePath = path.resolve(positional[0]);
  const sheetSelector = positional[1];
  if (!fs.existsSync(filePath)) die(`file not found: ${filePath}`);

  let ExcelJS = loadExcelJS();
  if (!ExcelJS) {
    installExcelJS();
    ExcelJS = loadExcelJS();
    if (!ExcelJS) die('exceljs installed but could not be loaded');
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    die(`failed to read workbook: ${err.message || err}`);
  }

  const sheetNames = workbook.worksheets.map((w) => w.name);
  let worksheet;
  if (sheetSelector == null) {
    worksheet = workbook.worksheets[0];
  } else if (/^\d+$/.test(sheetSelector)) {
    const idx = parseInt(sheetSelector, 10);
    worksheet = workbook.worksheets[idx];
    if (!worksheet) die(`sheet index ${idx} out of range (0..${sheetNames.length - 1})`);
  } else {
    worksheet = workbook.getWorksheet(sheetSelector);
    if (!worksheet) die(`sheet "${sheetSelector}" not found. available: ${sheetNames.join(', ')}`);
  }

  const mergedLookup = buildMergedLookup(worksheet);
  const lastCol = worksheet.actualColumnCount || worksheet.columnCount || 0;
  const lastRow = worksheet.actualRowCount || worksheet.rowCount || 0;

  // Headers from row 1
  const rawHeaders = [];
  for (let c = 1; c <= lastCol; c++) {
    rawHeaders.push(cellValue(worksheet, mergedLookup, 1, c));
  }
  const headers = dedupeHeaders(rawHeaders);

  // Determine data row range (rows 2..lastRow by default)
  const dataStart = range ? range.start : 2;
  const dataEnd = range ? range.end : lastRow;
  const totalDataRows = Math.max(0, lastRow - 1);
  const inWindowRows = Math.max(0, Math.min(lastRow, dataEnd) - dataStart + 1);

  const rows = [];
  let truncated = false;
  for (let r = dataStart; r <= Math.min(lastRow, dataEnd); r++) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    const rowObj = {};
    let hasAny = false;
    for (let c = 1; c <= lastCol; c++) {
      const v = cellValue(worksheet, mergedLookup, r, c);
      if (v !== null && v !== '') hasAny = true;
      rowObj[headers[c - 1]] = v;
    }
    if (hasAny) rows.push(rowObj);
  }

  const output = {
    file: path.basename(filePath),
    sheets: sheetNames,
    active_sheet: worksheet.name,
    headers,
    total_data_rows: totalDataRows,
    returned_rows: rows.length,
    truncated,
    range: range ? { start: range.start, end: range.end } : null,
    rows,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch((err) => die(err.stack || String(err)));
