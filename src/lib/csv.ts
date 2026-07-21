// Minimal RFC4180-ish CSV parser — handles quoted fields (with embedded
// commas/newlines) and "" escaped quotes. Good enough for the lead-import
// use case without pulling in a dependency.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r') {
      // ignore — \n (or end of text) closes the row
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

export function isBlankRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '')
}

// Quotes a field only when required (contains a comma, quote, or newline),
// doubling any embedded quotes per RFC4180.
function toCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(toCsvField).join(',')).join('\r\n')
}

export function downloadCsv(filename: string, rows: string[][]): void {
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
