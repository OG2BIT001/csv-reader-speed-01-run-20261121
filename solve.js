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
// - a record that lies on one line and holds no CR anywhere is parsed inside its
//   line slice with indexOf scans only: one scan to each comma for a plain field,
//   one scan to each closing quote for a quoted field (junk after a closing quote
//   is appended as it stands, as the reference reads it), every field one slice;
// - otherwise each field is found with one scan (indexOf for the next comma or
//   LF and a binary search in a precomputed list of CR positions for the next
//   CR; indexOf for the next quote) and taken as one slice.
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

  // The positions of every CR in the text, ascending, gathered in one pass.
  // The field-by-field path finds the next CR by binary search in this list
  // instead of scanning for one (a scan could roam far in a text whose CRs are
  // rare) or matching a regex per field (a match object per field).
  let crList = null;
  {
    let p = text.indexOf('\r');
    if (p !== -1) {
      crList = [];
      while (p !== -1) {
        crList.push(p);
        p = text.indexOf('\r', p + 1);
      }
    }
  }

  // The next comma, CR or LF at or after `from`: [index, charCode], or null
  // when none is left. Comma and LF are found with native scans (from an
  // unquoted field both are at most a record away), the CR by binary search.
  function nextDelim(from) {
    let best = -1;
    let bc = 0;
    const ci = text.indexOf(',', from);
    if (ci !== -1) {
      best = ci;
      bc = 44;
    }
    const li = text.indexOf('\n', from);
    if (li !== -1 && (best === -1 || li < best)) {
      best = li;
      bc = 10;
    }
    if (crList !== null) {
      let lo = 0;
      let hi = crList.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (crList[mid] < from) lo = mid + 1;
        else hi = mid;
      }
      if (lo < crList.length && (best === -1 || crList[lo] < best)) {
        best = crList[lo];
        bc = 13;
      }
    }
    return best === -1 ? null : [best, bc];
  }

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
      const m = nextDelim(pos);
      if (m === null) {
        const tail = text.slice(pos);
        value += tail;
        added += tail.length;
        pos = n;
        return [value, END, added];
      }
      const i = m[0];
      const c = m[1];
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

  // Tries to read one whole record from a single line slice `s` that is known to
  // hold no CR and no LF: plain fields end at the next comma, a field that opens
  // with a quote ends at its closing quote (a doubled quote inside is one quote),
  // and whatever follows a closing quote, up to the next comma or the slice's
  // end, is appended to the field as it stands (a quote_junk error, collected in
  // `errs` for the caller to report only when the whole record reads this way).
  // Returns the shared scratch object `att`, filled with {fields, quoted, errs}
  // (quoted: the last field opened with a quote), or null when the record is not
  // of this shape — a quote that does not close inside the slice — in which case
  // nothing has been read or reported and the caller reads the record field by
  // field from the full text instead.
  // The scratch result of tryLineRecord, refilled on every call and read by the
  // caller at once, so a bounded record costs no wrapper object; `errs` stays
  // null (and is read as no errors) unless a quote_junk is actually met.
  const att = { fields: null, quoted: false, errs: null };
  function tryLineRecord(s) {
    const L = s.length;
    if (L === 0) return null;
    const fields = [];
    let errs = null;
    let i = 0;
    let quoted = false;
    while (true) {
      if (s.charCodeAt(i) === 34) {
        quoted = true;
        let j = i + 1;
        let seg = j;
        let parts = null; // segments when "" is met inside the quotes
        let closed = -1;
        while (true) {
          const q = s.indexOf('"', j);
          if (q === -1) return null; // does not close on this line
          if (s.charCodeAt(q + 1) === 34) {
            if (parts === null) parts = [];
            parts.push(s.slice(seg, q), '"');
            j = q + 2;
            seg = j;
            continue;
          }
          closed = q;
          break;
        }
        const value = parts === null
          ? s.slice(i + 1, closed)
          : parts.join('') + s.slice(seg, closed);
        i = closed + 1;
        if (i >= L) {
          fields.push(value);
          att.fields = fields;
          att.quoted = quoted;
          att.errs = errs;
          return att;
        }
        if (s.charCodeAt(i) === 44) {
          fields.push(value);
          i += 1;
          if (i >= L) {
            fields.push('');
            att.fields = fields;
            att.quoted = quoted;
            att.errs = errs;
            return att;
          }
          continue;
        }
        // Junk after the closing quote: appended as it stands, up to the next
        // comma or the slice's end, and reported when the field ends.
        const jc = s.indexOf(',', i);
        const jEnd = jc === -1 ? L : jc;
        if (jEnd > i) {
          if (errs === null) errs = [];
          errs.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        fields.push(value + s.slice(i, jEnd));
        if (jc === -1) {
          att.fields = fields;
          att.quoted = quoted;
          att.errs = errs;
          return att;
        }
        i = jc + 1;
        if (i >= L) {
          fields.push('');
          att.fields = fields;
          att.quoted = quoted;
          att.errs = errs;
          return att;
        }
        continue;
      }
      quoted = false;
      const comma = s.indexOf(',', i);
      if (comma === -1) {
        fields.push(s.slice(i));
        att.fields = fields;
        att.quoted = quoted;
        att.errs = errs;
        return att;
      }
      fields.push(s.slice(i, comma));
      i = comma + 1;
      if (i >= L) {
        fields.push('');
        att.fields = fields;
        att.quoted = quoted;
        att.errs = errs;
        return att;
      }
    }
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

    // ---- Fast paths: records that lie on one line. ----
    // The record's line ends at the next LF (or the end of the text); a CR just
    // before that LF is the CRLF ending and is left out of the slice. Any other
    // CR in the slice — a stray CR, or one inside a quoted field, where it would
    // read as a line break — sends the record to the field-by-field path below,
    // as does a quoted field that does not close inside the slice.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? n : le;
    let recEnd = lineEnd;
    if (le !== -1 && recEnd > pos && text.charCodeAt(recEnd - 1) === 13) recEnd -= 1;
    const lineStr = text.slice(pos, recEnd);
    if (lineStr.indexOf('\r') === -1) {
      if (lineStr.indexOf('"') === -1) {
        // No quoted field and no stray CR: the record is taken whole.
        finishRecord(lineStr.split(','), false);
        pos = le === -1 ? n : le + 1;
        if (le !== -1) line += 1;
        continue;
      }
      const att = tryLineRecord(lineStr);
      if (att !== null) {
        if (att.errs !== null) for (const e of att.errs) errors.push(e);
        finishRecord(att.fields, att.quoted);
        pos = le === -1 ? n : le + 1;
        if (le !== -1) line += 1;
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
        if (span.indexOf('\r') === -1) {
          // No CR: the span's line breaks are its LFs (counted with native
          // scans, no match array built) and the value is the span itself.
          let nl = span.indexOf('\n');
          if (nl === -1) {
            value = span;
          } else {
            let cnt = 0;
            while (nl !== -1) {
              cnt += 1;
              nl = span.indexOf('\n', nl + 1);
            }
            line += cnt;
            value = span;
          }
        } else {
          // CRs present: line breaks are the LFs plus each lone CR (a CR of a
          // CRLF is counted with its LF), and CRs read as LF in the value.
          let cnt = 0;
          let p = span.indexOf('\n');
          while (p !== -1) {
            cnt += 1;
            p = span.indexOf('\n', p + 1);
          }
          p = span.indexOf('\r');
          while (p !== -1) {
            if (span.charCodeAt(p + 1) !== 10) cnt += 1;
            p = span.indexOf('\r', p + 1);
          }
          line += cnt;
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

      // A plain unquoted field: one scan to its end (nextDelim above).
      quoted = false;
      let value = null; // segments when a lone CR is dropped mid-field
      let segStart = pos;
      while (true) {
        const m = nextDelim(pos);
        if (m === null) {
          const tail = text.slice(segStart);
          value = value === null ? tail : value + tail;
          pos = n;
          ended = END;
          break;
        }
        const i = m[0];
        const c = m[1];
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
