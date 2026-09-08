export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

const REQUIRED_HEADERS = ["platform_id", "enabled", "priority", "status"];
const OPTIONAL_HEADERS = ["listing_name", "listing_url", "last_checked", "notes"];
const ALL_VALID_HEADERS = [...REQUIRED_HEADERS, ...OPTIONAL_HEADERS];

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseCsv(raw: string): CsvParseResult {
  const content = raw.replace(/^\uFEFF/, "");
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = parseCsvLines(normalized);

  if (lines.length === 0) {
    throw new CsvParseError("CSV is empty");
  }

  const headers = lines[0];

  if (headers.length === 0) {
    throw new CsvParseError("CSV has no headers");
  }

  const headerSet = new Set<string>();
  for (const h of headers) {
    if (headerSet.has(h)) {
      throw new CsvParseError(`Duplicate header: "${h}"`);
    }
    headerSet.add(h);
    if (!ALL_VALID_HEADERS.includes(h)) {
      throw new CsvParseError(`Unknown header: "${h}"`);
    }
  }

  for (const required of REQUIRED_HEADERS) {
    if (!headerSet.has(required)) {
      throw new CsvParseError(`Missing required header: "${required}"`);
    }
  }

  const rows: Record<string, string>[] = [];
  const platformIds = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i];

    if (values.length === 1 && values[0].trim() === "") {
      continue;
    }

    if (values.length !== headers.length) {
      throw new CsvParseError(
        `Row ${i + 1}: expected ${headers.length} columns, got ${values.length}`,
      );
    }

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j].trim();
    }

    if (!row.platform_id) {
      throw new CsvParseError(`Row ${i + 1}: platform_id is empty`);
    }

    if (platformIds.has(row.platform_id)) {
      throw new CsvParseError(`Row ${i + 1}: duplicate platform_id "${row.platform_id}"`);
    }
    platformIds.add(row.platform_id);

    if (row.enabled !== "true" && row.enabled !== "false") {
      throw new CsvParseError(
        `Row ${i + 1} (${row.platform_id}): enabled must be "true" or "false", got "${row.enabled}"`,
      );
    }

    rows.push(row);
  }

  return { headers, rows };
}

function parseCsvLines(text: string): string[][] {
  const result: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
      } else if (char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        result.push(currentRow);
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  if (currentField !== "" || currentRow.length > 0) {
    currentRow.push(currentField);
    result.push(currentRow);
  }

  return result;
}
