/**
 * Parser CSV robusto.
 * - Detecta delimitador (vírgula, ponto-e-vírgula ou tab).
 * - Remove BOM UTF-8.
 * - Preserva espaços internos.
 * - Suporta campos entre aspas, incluindo quebra de linha e aspas duplas escapadas.
 */

function stripBom(text) {
  if (text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/)[0] || "";
  const counts = {
    ",": (firstLine.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length,
    ";": (firstLine.match(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
  };
  let best = ",";
  let bestCount = counts[","];
  for (const [delim, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = delim;
      bestCount = count;
    }
  }
  return best;
}

function parseCsvRobust(rawText) {
  const text = stripBom(String(rawText || ""));
  if (!text.trim()) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(text);
  const rows = [];
  let current = [];
  let value = "";
  let insideQuotes = false;
  let i = 0;

  function pushValue() {
    current.push(value);
    value = "";
  }

  function pushRow() {
    if (current.length > 0 || value !== "") {
      pushValue();
      rows.push(current);
      current = [];
    }
  }

  function isDelimiter(char) {
    return char === delimiter;
  }

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (insideQuotes) {
      if (char === '"') {
        if (next === '"') {
          value += '"';
          i += 2;
          continue;
        }
        insideQuotes = false;
      } else {
        value += char;
      }
    } else {
      if (char === '"') {
        insideQuotes = true;
      } else if (isDelimiter(char)) {
        pushValue();
      } else if (char === "\r") {
        if (next === "\n") i++;
        pushRow();
      } else if (char === "\n") {
        pushRow();
      } else {
        value += char;
      }
    }
    i++;
  }
  pushRow();

  const headers = rows[0] || [];
  const dataRows = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 0 || cells.every((c) => c === "")) continue;
    const row = {};
    for (let h = 0; h < headers.length; h++) {
      row[headers[h]] = cells[h] !== undefined ? cells[h] : "";
    }
    dataRows.push(row);
  }
  return { headers, rows: dataRows, delimiter };
}

function writeCsv(rows, headers, delimiter = ",") {
  const escape = (value) => {
    const str = value === null || value === undefined ? "" : String(value);
    if (/[\r\n",]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const lines = [headers.map(escape).join(delimiter)];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(delimiter));
  }
  return lines.join("\n") + "\n";
}

module.exports = {
  detectDelimiter,
  parseCsvRobust,
  stripBom,
  writeCsv,
};
