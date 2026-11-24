// solve.js — a faster drop-in for makefun-site 1.0.0 (MIT).
//
// run(input) returns exactly what makefun-site 1.0.0's build returns for the
// same input: the output tree (path -> text), byte for byte. The semantics
// are reimplemented from makefun-site's own code (front matter, Markdown
// subset, template dialect, slug rule, report), with the hot paths rewritten:
// a single-pass inline scanner, a first-character block dispatcher, a
// memoised slugify with an ASCII fast path, compiled templates rendered into
// a chunk array with reusable loop frames, and each source's card computed
// once. No cross-case caching: every cache is created fresh inside run().
// No clock, no randomness, no environment, no I/O.

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * The characters the inline scanner acts on, by code: exactly the first
 * characters of its tokens (backslash, backtick, *, [, and the five escaped
 * characters & < > " '). The fast-path regex below is generated from this
 * one list; any character added to the scanner's grammar must be added here.
 */
const INLINE_SPECIAL_CODES = [92, 96, 42, 91, 38, 60, 62, 34, 39]; // \ ` * [ & < > " '
/** The same set as a regex (no /g/: test() must not move lastIndex). */
const INLINE_SPECIAL_RE = new RegExp(`[${INLINE_SPECIAL_CODES.map((c) => (c === 92 || c === 91 ? '\\' : '') + String.fromCharCode(c)).join('')}]`);

/** `text` with & < > " and ' escaped. A test first: most inputs hold no
 * special character, and a bare test is ~2x cheaper than a replace that
 * finds nothing (microbench on the real 119k inputs: 148ms vs 329ms). */
const ESCAPE_RE = /[&<>"']/;
const ESCAPE_RE_G = /[&<>"']/g;
function escapeHtml(text) {
  if (!ESCAPE_RE.test(text)) return text;
  return text.replace(ESCAPE_RE_G, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left. The ASCII fast path is exact: NFKD is the identity on
 * ASCII and ASCII holds no combining marks.
 */
function slugify(text) {
  if (/^[\x00-\x7F]*$/.test(text)) {
    let out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    const last = out.length - 1;
    if (last >= 0 && out.charCodeAt(last) === 45) out = out.slice(0, last);
    out = out.slice(0, SLUG_MAX);
    const cut = out.length - 1;
    if (cut >= 0 && out.charCodeAt(cut) === 45) out = out.replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends.
 */
function parseFrontMatter(text) {
  const fast = parseFrontMatterFast(text);
  return fast === null ? parseFrontMatterSlow(text) : fast;
}

/**
 * Front-matter fast path (item 8): one indexOf scan for the closing
 * delimiter, then per-line indexOf(':') + trim into a fixed-shape object —
 * no split('\n') of the whole body, no per-line regex, no body re-join.
 * Returns null (bail to parseFrontMatterSlow) on ANY construct it does not
 * recognise outright — quoted values, unknown/duplicate keys, empty values,
 * value errors — so the slow path still produces every such error message
 * exactly as before. Only a fully recognised, fully validated front matter
 * returns here (the 'no title' error is returned directly, same message).
 */
function parseFrontMatterFast(text) {
  if (!text.startsWith('---\n')) return null;
  // First line exactly '---': its closing line is the first later line exactly '---'.
  let j = text.indexOf('\n---', 3);
  let closeEnd = -1;
  while (j !== -1) {
    const after = j + 4;
    if (after === text.length) {
      closeEnd = after;
      break;
    }
    if (text.charCodeAt(after) === 10) {
      closeEnd = after + 1;
      break;
    }
    j = text.indexOf('\n---', after);
  }
  if (closeEnd === -1) return null;
  const data = {};
  let hasTitle = false;
  let p = 4;
  while (p < j) {
    const e = text.indexOf('\n', p);
    const lineEnd = e === -1 || e > j ? j : e;
    const line = text.slice(p, lineEnd);
    p = lineEnd + 1;
    if (line === '') continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 35) continue; // a '#' comment line
    if (c0 === 32 || c0 === 9) {
      let blank = true;
      for (let k = 0; k < line.length; k++) {
        const cc = line.charCodeAt(k);
        if (cc !== 32 && cc !== 9) {
          blank = false;
          break;
        }
      }
      if (blank) continue;
      return null; // leading whitespace before a key: the slow path errors
    }
    let k = 0;
    while (k < line.length) {
      const cc = line.charCodeAt(k);
      if ((cc >= 97 && cc <= 122) || cc === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return null;
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return null; // 'key:value': the slow path errors
    let rEnd = raw.length;
    while (rEnd > 0) {
      const cc = raw.charCodeAt(rEnd - 1);
      if (cc === 32 || cc === 9) rEnd--;
      else break;
    }
    if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
    if (!KEYS.includes(key)) return null;
    if (Object.hasOwn(data, key)) return null;
    if (raw === '') return null;
    const v = valueOf(key, raw);
    if ('error' in v) return null;
    data[key] = v.value;
    if (key === 'title') hasTitle = true;
  }
  if (!hasTitle) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

function parseFrontMatterSlow(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** A link target holding whitespace is not a link. */
const WS_RE = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  // Construct-free fast path: with no special character the output is the input itself.
  if (!INLINE_SPECIAL_RE.test(s)) return s;
  const re = /\\[\\`*_\[\]()#+\-.!>]|`|\*\*|\*|\[|[&<>"']/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const tok = m[0];
    if (tok === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += s.slice(last, j);
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        re.lastIndex = k + 1;
        last = k + 1;
      }
      // else a literal backtick: it stays in the plain run
    } else if (tok === '**') {
      const k = findUnescaped(s, '**', j + 2);
      if (k > j + 2) {
        out += s.slice(last, j);
        out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
        re.lastIndex = k + 2;
        last = k + 2;
      }
      // else a literal **: it stays in the plain run
    } else if (tok === '*') {
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += s.slice(last, j);
        out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        re.lastIndex = k + 1;
        last = k + 1;
      }
      // else a literal *: it stays in the plain run
    } else if (tok === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const close = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = close === -1 ? '' : s.slice(k + 2, close);
      if (target !== '' && !WS_RE.test(target)) {
        out += s.slice(last, j);
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        re.lastIndex = close + 1;
        last = close + 1;
      }
      // else a literal [: it stays in the plain run
    } else if (tok.charCodeAt(0) === 92) {
      // a backslash escape: the escaped character, itself escaped
      out += s.slice(last, j);
      const c = tok[1];
      out += ESCAPES[c] ?? c;
      last = j + 2;
    } else {
      out += s.slice(last, j);
      out += ESCAPES[tok];
      last = j + 1;
    }
  }
  out += s.slice(last);
  return out;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank: empty or only spaces/tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

const LANG_CHAR = /^[A-Za-z0-9_+-]$/;

/** A fence's language, or null when `line` does not open a fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && LANG_CHAR.test(line[i])) i++;
  const lang = line.slice(3, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` closes a fence: ``` plus only spaces/tabs. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let n = 0;
  while (n < 6 && line.charCodeAt(n) === 35) n++;
  if (n === 0) return null;
  const after = line[n];
  if (after !== ' ' && after !== '\t') return null;
  let a = n;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: --- or *** plus only spaces/tabs. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  const mark = c === 45 ? '---' : '***';
  if (!line.startsWith(mark)) return false;
  for (let i = 3; i < line.length; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

const CONTINUED = /^ {2,}\S/;

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.length === 0 ? 0 : line.charCodeAt(0);
  if (c === 0) return true;
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * `slugifyM` is the run's memoised slugify.
 */
function renderMarkdown(src, env, slugifyM) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const c = line.length === 0 ? 0 : line.charCodeAt(0);
    if (c === 0 || c === 32 || c === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // a paragraph line starting with spaces/tabs
    } else if (c === 96) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>`);
        continue;
      }
    } else if (c === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugifyM(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c === 45 || c === 42) {
      if (isHr(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      if (line.charCodeAt(1) === 32) {
        // bullet list, handled below
      } else {
        // paragraph below
      }
    } else if (c === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(l);
      }
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // list?
    if (c === 45 || c === 42) {
      if (line.charCodeAt(1) === 32) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
            items.push([trimLine(l.slice(2))]);
            i++;
          } else if (CONTINUED.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        blocks.push(`<ul>\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</ul>`);
        continue;
      }
    } else if (c >= 48 && c <= 57) {
      let d = 0;
      while (d < 9 && lines[i].charCodeAt(d) >= 48 && lines[i].charCodeAt(d) <= 57) d++;
      if (d >= 1 && lines[i].charCodeAt(d) === 46 && lines[i].charCodeAt(d + 1) === 32) {
        const start = Number(lines[i].slice(0, d));
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          let dd = 0;
          while (dd < 9 && l.charCodeAt(dd) >= 48 && l.charCodeAt(dd) <= 57) dd++;
          if (dd >= 1 && l.charCodeAt(dd) === 46 && l.charCodeAt(dd + 1) === 32) {
            items.push([trimLine(l.slice(dd + 2))]);
            i++;
          } else if (CONTINUED.test(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        blocks.push(`${open}\n${items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('')}</ol>`);
        continue;
      }
    }
    // paragraph
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A node tree compiled into flat op lists (if/for bodies nested, never re-walked as a tree). */
function compile(nodes) {
  const ops = [];
  for (const n of nodes) {
    if (n.kind === 'text' || n.kind === 'var' || n.kind === 'raw' || n.kind === 'include') ops.push(n);
    else if (n.kind === 'if') ops.push({ kind: 'if', not: n.not, path: n.path, then: compile(n.then), else: n.else === null ? null : compile(n.else) });
    else if (n.kind === 'for') ops.push({ kind: 'for', name: n.name, path: n.path, body: compile(n.body) });
  }
  return ops;
}

/** The value at `path` in the frame stack: its first name from the nearest frame holding it, then own properties. */
function lookup(frames, path) {
  const first = path[0];
  for (let i = frames.length - 1; i >= 0; i--) {
    const vars = frames[i];
    // A frame never owns a key with value undefined here: the root frame's
    // values are all built objects, and a for-frame's loop variable is
    // assigned its element before its body renders (and an empty loop never
    // renders its body) — so `!== undefined` is exactly `hasOwn` here, and
    // measurably cheaper (microbench: 17.6ms vs 24.4ms per 280k lookups).
    const v0 = vars[first];
    if (v0 !== undefined) {
      let v = v0;
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `ops` rendered into `out` (a chunk array) under the frame stack; `templates` maps names to compiled ops. */
function renderOps(ops, frames, templates, depth, out) {
  for (const n of ops) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(frames, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(frames, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderOps(branch, frames, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        const frame = { [n.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };
        const loop = frame.loop;
        frames.push(frame);
        for (let k = 0; k < xs.length; k++) {
          frame[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderOps(n.body, frames, templates, depth, out);
        }
        frames.pop();
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderOps(t, frames, templates, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** The words of a body: its runs of characters other than whitespace (a manual scan — the same set \S negates — with no allocation). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200A; c++) WS_TABLE[c] = 1;
function wordsOf(text) {
  let n = 0;
  let inWord = 0;
  for (let i = 0; i < text.length; i++) {
    // Branchless: the branchy version mispredicts on every word boundary
    // (microbench on the real bodies: 303ms vs 706ms per 30 passes).
    const ws = WS_TABLE[text.charCodeAt(i)];
    n += (1 - ws) & (1 - inWord);
    inWord = 1 - ws;
  }
  return n;
}

/** A link target with a scheme (`https:`, `mailto:` …). */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  // String fast path (microbench on the real 3,272 pairs: 1,162ms vs 3,626ms
  // per 2,000 passes): strip the leading "../" run by slicing `dir`, then
  // concatenate the plain tail. Anything irregular in the tail — an interior
  // "..", a "." segment, "//", a trailing "/" — falls back to the split
  // algorithm below, which is the exact original.
  let base = dir;
  let rest = rel;
  while (rest.startsWith('../')) {
    if (base === '') return null;
    const i = base.lastIndexOf('/');
    base = i === -1 ? '' : base.slice(0, i);
    rest = rest.slice(3);
  }
  if (rest === '..') {
    if (base === '') return null;
    const i = base.lastIndexOf('/');
    return i === -1 ? '' : base.slice(0, i);
  }
  if (rest === '') return base;
  if (rest.includes('..') || rest.includes('//') || rest.endsWith('/') || rest === '.' || rest.startsWith('./') || rest.includes('/./') || rest.endsWith('/.')) {
    const parts = dir === '' ? [] : dir.split('/');
    for (const seg of rel.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length === 0) return null;
        parts.pop();
      } else parts.push(seg);
    }
    return parts.join('/');
  }
  return base === '' ? rest : `${base}/${rest}`;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  // Fresh per-run caches (nothing survives from one case to the next).
  const slugMemo = new Map();
  const slugifyM = (text) => {
    let s = slugMemo.get(text);
    if (s === undefined) {
      s = slugify(text);
      slugMemo.set(text, s);
    }
    return s;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compile(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugifyM(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugifyM);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugifyM(name)) && seen.add(slugifyM(name)));
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugifyM(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugifyM(name)) ?? { name, slug: slugifyM(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A page's link record as templates read it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  // A post's card, as lists show it (computed once per source, reused by pageOf).
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };

  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    const out = [];
    renderOps(ops, [{ site, tags: allTags, recent, ...vars }], templates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
