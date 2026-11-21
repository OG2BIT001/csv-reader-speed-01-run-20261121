// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): it returns exactly
// csv-reader's answer {columns, rows, errors} for every input, and nothing else.
//
// The reference reads one character at a time and builds each field a character at a
// time. This one reads the same way, left to right, with the same broken-row policy,
// but finds each field's end with native scans and takes fields as slices, so the
// common case costs a few native calls instead of a JavaScript loop per character:
//
// - a record with no quoted field and no stray CR is taken whole: one slice and one
//   split(',') for the entire record;
// - otherwise each field is found with one native scan (a regex for the next comma,
//   CR or LF; indexOf for the next quote) and taken as one slice.
// The rare broken cases (a lone CR in an unquoted field, a quote that never closes,
// junk after a closing quote, a newline inside a quoted field) follow the reference
// step for step, so the answers stay identical.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: 0 at a comma (the record goes on), 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The next comma, CR or LF at or after pos, or -1. One native scan.
  const DELIM = /[,\r\n]/g;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads unquoted characters onto `value` up to the next comma or line break, the
  // way the reference does: a CR not followed by LF is dropped (stray_cr). Returns
  // [value, ended, added], where added counts the characters kept. Used only for
  // the rare paths (junk after a closing quote, a quote that never closes).
  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        const tail = text.slice(pos);
        value += tail;
        added += tail.length;
        pos = n;
        return [value, END, added];
      }
      const i = m.index;
      const c = text.charCodeAt(i);
      if (c === 44) {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        return [value, COMMA, added];
      }
      if (c === 10) {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 1;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      // A CR: with LF it ends the record, alone it is dropped (stray_cr).
      if (text.charCodeAt(i + 1) === 10) {
        value += text.slice(pos, i);
        added += i - pos;
        pos = i + 2;
        line += 1;
        return [value, LINE_BREAK, added];
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(pos, i);
      added += i - pos;
      pos = i + 1;
    }
    return [value, END, added];
  }

  // Finishes a record that has been read: a line that held only stray CRs is no
  // record; the first record sets the width (and is the header when header is
  // true); the rest are padded or cut to it.
  function finishRecord(fields, quoted) {
    if (fields.length === 1 && fields[0] === '' && !quoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // ---- Fast path: a record with no quoted field and no stray CR. ----
    // The record ends at the next LF (or the end of the text). A quote before
    // that end, or a CR anywhere but the one of a CRLF ending, sends the record
    // to the field-by-field path below.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? n : le;
    const qi = text.indexOf('"', pos);
    if (qi === -1 || qi >= lineEnd) {
      const ri = text.indexOf('\r', pos);
      if ((ri === -1 || ri >= lineEnd) && le !== -1) {
        // No CR at all, LF ending.
        finishRecord(text.slice(pos, lineEnd).split(','), false);
        pos = le + 1;
        line += 1;
        continue;
      }
      if (ri === -1 && le === -1) {
        // No CR at all, end of text.
        finishRecord(text.slice(pos, lineEnd).split(','), false);
        pos = n;
        continue;
      }
      if (le !== -1 && ri === lineEnd - 1) {
        // The only CR is the one of the CRLF ending.
        finishRecord(text.slice(pos, lineEnd - 1).split(','), false);
        pos = le + 1;
        line += 1;
        continue;
      }
    }

    // ---- Field by field, for records with quoted fields or stray CRs. ----
    const fields = [];
    let ended;
    let quoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        quoted = true;
        const open = pos;
        const openLine = line;
        let q = pos + 1;
        let segStart = q;
        let parts = null; // segments when "" is met inside the quotes
        let closedAt = -1;
        while (true) {
          const qi2 = text.indexOf('"', q);
          if (qi2 === -1) break; // the quote never closes
          if (text.charCodeAt(qi2 + 1) === 34) {
            if (parts === null) parts = [];
            parts.push(text.slice(segStart, qi2), '"');
            q = qi2 + 2;
            segStart = q;
            continue;
          }
          closedAt = qi2;
          break;
        }
        if (closedAt === -1) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          pos = open + 1;
          line = openLine;
          const r = readUnquoted('"');
          fields.push(r[0]);
          ended = r[1];
          continue;
        }
        // The quoted span is [open + 1, closedAt). Newlines in it count as
        // lines and each CRLF or lone CR in it reads as LF in the value.
        const span = parts === null
          ? text.slice(open + 1, closedAt)
          : parts.join('') + text.slice(segStart, closedAt);
        let value;
        if (span.indexOf('\n') === -1 && span.indexOf('\r') === -1) {
          value = span;
        } else {
          const breaks = span.match(/\r\n?|\n/g);
          if (breaks !== null) line += breaks.length;
          value = span.replace(/\r\n?/g, '\n');
        }
        pos = closedAt + 1;
        if (pos >= n) {
          fields.push(value);
          ended = END;
          continue;
        }
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          fields.push(value);
          ended = COMMA;
          continue;
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          fields.push(value);
          ended = LINE_BREAK;
          continue;
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fields.push(value);
          ended = LINE_BREAK;
          continue;
        }
        // What follows the closing quote is appended as it stands, up to the
        // next comma or line break.
        const junk = readUnquoted(value);
        if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        fields.push(junk[0]);
        ended = junk[1];
        continue;
      }

      // A plain unquoted field: one native scan to its end.
      quoted = false;
      let value = null; // segments when a lone CR is dropped mid-field
      let segStart = pos;
      while (true) {
        DELIM.lastIndex = pos;
        const m = DELIM.exec(text);
        if (m === null) {
          const tail = text.slice(segStart);
          value = value === null ? tail : value + tail;
          pos = n;
          ended = END;
          break;
        }
        const i = m.index;
        const c = text.charCodeAt(i);
        if (c === 44) {
          value = value === null ? text.slice(segStart, i) : value + text.slice(segStart, i);
          pos = i + 1;
          ended = COMMA;
          break;
        }
        if (c === 10) {
          value = value === null ? text.slice(segStart, i) : value + text.slice(segStart, i);
          pos = i + 1;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        if (text.charCodeAt(i + 1) === 10) {
          value = value === null ? text.slice(segStart, i) : value + text.slice(segStart, i);
          pos = i + 2;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        // A lone CR: dropped (stray_cr), the field goes on.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value = value === null ? text.slice(segStart, i) : value + text.slice(segStart, i);
        pos = i + 1;
        segStart = pos;
      }
      fields.push(value);
    } while (ended === COMMA);

    finishRecord(fields, quoted);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
