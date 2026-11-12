// Small RFC 4180 CSV parser: quoted fields with commas, doubled quotes and
// newlines, CRLF or LF, a trailing empty column. Chunked so a large file never
// has to sit in memory as one string: push() text as it arrives, rows come out
// through the callback, end() flushes the last row.
export interface CsvParser {
  push(chunk: string): void;
  end(): void;
}

export function createCsvParser(onRow: (fields: string[]) => void): CsvParser {
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let pendingQuote = false;    // saw a quote inside a quoted field: either "" or the closing quote
  let sawAny = false;          // current row has any content (a lone blank line is skipped)

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (sawAny || row.length > 1) onRow(row);
    row = []; sawAny = false;
  };

  return {
    push(chunk: string) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (pendingQuote) {
          pendingQuote = false;
          if (c === '"') { field += '"'; continue; }      // "" -> literal quote
          inQuotes = false;                                // it was the closing quote; handle c below
        }
        if (inQuotes) {
          if (c === '"') pendingQuote = true; else field += c;
          continue;
        }
        if (c === '"' && field === '') { inQuotes = true; sawAny = true; }
        else if (c === ',') { endField(); sawAny = true; }
        else if (c === '\n') endRow();
        else if (c === '\r') { /* part of CRLF */ }
        else { field += c; sawAny = true; }
      }
    },
    end() {
      if (pendingQuote) { pendingQuote = false; inQuotes = false; }
      if (inQuotes) throw new Error('csv: unterminated quoted field');
      if (field !== '' || row.length > 0 || sawAny) endRow();
    },
  };
}

// Whole-string convenience (tests, small files).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const p = createCsvParser((r) => rows.push(r));
  p.push(text);
  p.end();
  return rows;
}
