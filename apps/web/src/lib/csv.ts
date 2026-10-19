/**
 * Reads a CSV (or tab- or semicolon-separated) table: quoted fields may hold separators, quotes ("") and line
 * breaks. The separator is whichever of comma, tab and semicolon appears most in the first line.
 */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.slice(0, body.search(/\r?\n/) >>> 0 || body.length);
  const sep = [",", "\t", ";"].sort((a, b) => count(firstLine, b) - count(firstLine, a))[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;
