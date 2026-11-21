// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader): run(input) returns
// exactly the answer csv-reader returns for every input — {columns, rows, errors} —
// with one left-to-right pass over the text. No regex on the hot path and no
// per-character work: a line with no quote and no carriage return is sliced and split
// in one go, and every other field is found with indexOf and sliced whole. Nothing is
// kept from one call to the next.

/** How a field ended: at the end of the text, at a comma, or at a line break. */
const END = 0;
const COMMA = 1;
const BREAK = 2;

/**
 * How many line breaks a quoted segment holds: each CR counts once, each LF counts
 * once unless the character before it is a CR (a CRLF is one break).
 */
function countBreaks(s) {
  let breaks = 0;
  let p = s.indexOf('\r');
  while (p !== -1) {
    breaks += 1;
    p = s.indexOf('\r', p + 1);
  }
  p = s.indexOf('\n');
  while (p !== -1) {
    if (p === 0 || s.charCodeAt(p - 1) !== 13) breaks += 1;
    p = s.indexOf('\n', p + 1);
  }
  return breaks;
}

/**
 * A quoted segment as csv-reader reads it: every CRLF and every lone CR inside it is
 * one LF. Returns [value, lineBreaks]. The common case (no CR and no LF) is returned
 * untouched.
 */
function normSeg(s) {
  if (s.indexOf('\r') === -1 && s.indexOf('\n') === -1) return [s, 0];
  const breaks = countBreaks(s);
  return [s.indexOf('\r') === -1 ? s : s.replace(/\r\n?/g, '\n'), breaks];
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = n > 0 && text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

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

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's line holds no quote and no carriage return, except
    // that a single CR at its very end is the CR of a CRLF line break.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const lineText = text.slice(pos, lineEnd);
    const rAt = lineText.indexOf('\r');
    const crlf = nl !== -1 && rAt !== -1 && rAt === lineText.length - 1;
    if (lineText.indexOf('"') === -1 && (rAt === -1 || crlf)) {
      const body = crlf ? lineText.slice(0, -1) : lineText;
      if (body.length === 0) {
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
        continue;
      }
      const fields = body.split(',');
      pos = nl === -1 ? n : nl + 1;
      if (nl !== -1) line += 1;
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // Slow path: the line holds a quote or a carriage return; read field by field.
    const fields = [];
    let fValue;
    let fEnd;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (!quoted) {
        // An unquoted field: up to the next comma or line break, sliced whole.
        // A CR inside it is dropped (stray_cr), except the CR of a CRLF at the end.
        const i1 = text.indexOf(',', pos);
        const i2 = text.indexOf('\n', pos);
        let m = -1;
        let kind = END;
        if (i1 !== -1) {
          m = i1;
          kind = COMMA;
        }
        if (i2 !== -1 && (m === -1 || i2 < m)) {
          m = i2;
          kind = BREAK;
        }
        const end = m === -1 ? n : m;
        let seg = text.slice(pos, end);
        if (kind === BREAK && seg.length > 0 && seg.charCodeAt(seg.length - 1) === 13) {
          seg = seg.slice(0, -1);
        }
        const cr = seg.indexOf('\r');
        if (cr === -1) {
          fValue = seg;
        } else {
          let count = 0;
          let p = cr;
          while (p !== -1) {
            count += 1;
            p = seg.indexOf('\r', p + 1);
          }
          for (let i = 0; i < count; i += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          fValue = seg.split('\r').join('');
        }
        if (m === -1) {
          pos = n;
          fEnd = END;
        } else if (kind === COMMA) {
          pos = m + 1;
          fEnd = COMMA;
        } else {
          pos = m + 1;
          line += 1;
          fEnd = BREAK;
        }
      } else {
        // A quoted field: runs to the next quote that is not doubled.
        const open = pos;
        const openLine = line;
        let qSegs = null;
        let qBreaks = 0;
        let qStart = pos + 1;
        let closed = false;
        let closePos = -1;
        let q = text.indexOf('"', qStart);
        while (q !== -1) {
          if (text.charCodeAt(q + 1) === 34) {
            const part = normSeg(text.slice(qStart, q));
            if (qSegs === null) qSegs = [];
            qSegs.push(part[0], '"');
            qBreaks += part[1];
            qStart = q + 2;
            q = text.indexOf('"', qStart);
            continue;
          }
          closed = true;
          closePos = q;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text after
          // it is read again as an unquoted field starting with '"'.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const i1 = text.indexOf(',', pos);
          const i2 = text.indexOf('\n', pos);
          let m = -1;
          let kind = END;
          if (i1 !== -1) {
            m = i1;
            kind = COMMA;
          }
          if (i2 !== -1 && (m === -1 || i2 < m)) {
            m = i2;
            kind = BREAK;
          }
          const end = m === -1 ? n : m;
          let seg = text.slice(pos, end);
          if (kind === BREAK && seg.length > 0 && seg.charCodeAt(seg.length - 1) === 13) {
            seg = seg.slice(0, -1);
          }
          const cr = seg.indexOf('\r');
          if (cr === -1) {
            fValue = '"' + seg;
          } else {
            let count = 0;
            let p = cr;
            while (p !== -1) {
              count += 1;
              p = seg.indexOf('\r', p + 1);
            }
            for (let i = 0; i < count; i += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            fValue = '"' + seg.split('\r').join('');
          }
          if (m === -1) {
            pos = n;
            fEnd = END;
          } else if (kind === COMMA) {
            pos = m + 1;
            fEnd = COMMA;
          } else {
            pos = m + 1;
            line += 1;
            fEnd = BREAK;
          }
        } else {
          const last = normSeg(text.slice(qStart, closePos));
          const value = qSegs === null ? last[0] : (qSegs.push(last[0]), qSegs.join(''));
          line += qBreaks + last[1];
          pos = closePos + 1;
          if (pos >= n) {
            fValue = value;
            fEnd = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              fValue = value;
              fEnd = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              fValue = value;
              fEnd = BREAK;
            } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fValue = value;
              fEnd = BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up to
              // the next comma or line break (quote_junk when anything is added).
              const i1 = text.indexOf(',', pos);
              const i2 = text.indexOf('\n', pos);
              let m = -1;
              let kind = END;
              if (i1 !== -1) {
                m = i1;
                kind = COMMA;
              }
              if (i2 !== -1 && (m === -1 || i2 < m)) {
                m = i2;
                kind = BREAK;
              }
              const end = m === -1 ? n : m;
              let seg = text.slice(pos, end);
              if (kind === BREAK && seg.length > 0 && seg.charCodeAt(seg.length - 1) === 13) {
                seg = seg.slice(0, -1);
              }
              const cr = seg.indexOf('\r');
              let added;
              if (cr === -1) {
                fValue = value + seg;
                added = seg.length;
              } else {
                let count = 0;
                let p = cr;
                while (p !== -1) {
                  count += 1;
                  p = seg.indexOf('\r', p + 1);
                }
                for (let i = 0; i < count; i += 1) errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
                const clean = seg.split('\r').join('');
                fValue = value + clean;
                added = clean.length;
              }
              if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              if (m === -1) {
                pos = n;
                fEnd = END;
              } else if (kind === COMMA) {
                pos = m + 1;
                fEnd = COMMA;
              } else {
                pos = m + 1;
                line += 1;
                fEnd = BREAK;
              }
            }
          }
        }
      }
      fields.push(fValue);
    } while (fEnd === COMMA);

    // A line that held only stray CRs is left with no characters: no record.
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
