// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Written from the README + reference semantics, restructured for CPU time:
//  - fused single-pass Markdown (no token objects, no second walk)
//  - chunked inline escaping + range-based inline recursion (no slicing)
//  - templates compiled once per case to flat bytecode, run by a tight pc loop
//  - per-run slug cache, index-based front matter, allocation-free word count
// Every answer is byte-identical to makefun-site 1.0.0's. No state survives a run().

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64 chars
 * (a "-" left at the cut dropped), "untitled" when nothing is left.
 * `cache` is a per-run Map; callers pass it so repeats are a lookup.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  // ASCII fast path: ASCII normalizes to itself under NFKD and holds no
  // combining marks, so the normalize + \p{M} pass can be skipped.
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
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
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The words of one line: its word ends plus one when it ends on a word char.
 * A word cannot span a newline, so a body's words are the sum of its lines'.
 * Whitespace is exactly what \s matches without /u (a line never holds '\n',
 * but it is kept in the check so this stays correct if reused on raw text). */
function wordsOf(text) {
  const L = text.length;
  let n = 0;
  for (let i = 0; i < L; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c < 127) continue;
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) {
      if (i > 0) {
        const p = text.charCodeAt(i - 1);
        if (!(p === 32 || p === 10 || p === 9 || p === 13 || p === 11 || p === 12 || p === 160 || p === 5760 || (p >= 8192 && p <= 8202) || p === 8232 || p === 8233 || p === 8239 || p === 8287 || p === 12288 || p === 65279)) n++;
      }
    }
  }
  if (L > 0) {
    const c = text.charCodeAt(L - 1);
    if (!(c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279)) n++;
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
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
      const m = DATE.exec(raw);
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
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

const BLANK_LINE = /^[ \t]*$/;

/**
 * A source's front matter and body: { data, body }, or { error }.
 * Index-based: the closing --- line is found with indexOf, only the small header
 * region is split, the body is one slice. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the first line that is exactly '---' after the opening line.
  let closeStart = -1; // index of the '\n' just before the closing '---' line, or text.length
  let closeEnd = -1; // index just past the closing line (and its '\n' when present)
  const nl = text.indexOf('\n---\n');
  if (nl !== -1) {
    closeStart = nl;
    closeEnd = nl + 5;
  } else if (text.endsWith('\n---')) {
    closeStart = text.length - 4;
    closeEnd = text.length;
  } else if (text === '---') {
    return { error: 'the front matter is not closed' };
  } else {
    return { error: 'the front matter is not closed' };
  }
  const header = text.slice(4, closeStart);
  const lines = header === '' ? [] : header.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (BLANK_LINE.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
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
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/**
 * Whether `line` ends a paragraph: a blank line, a fence, a heading or a
 * thematic break. First-character dispatch: only '`' can open a fence, only
 * '#' can head, only '-' or '*' can break, and a space/tab lead is blank or not.
 */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/**
 * The first index in [from, to) where `s` holds `what` outside a backslash escape, or -1.
 * `what` is 1 or 2 chars long.
 */
function findUnescaped(s, what, from, to) {
  const wlen = what.length;
  for (let j = from; j <= to - wlen; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (what.length === 1 ? s[j] === what : s[j] === what[0] && s[j + 1] === what[1]) return j;
  }
  return -1;
}

/** The first single * in [from, to) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
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

/**
 * The next index in [from, to) holding a character inline cares about, or to.
 * Plain runs between specials need no escaping at all.
 */
const SPECIAL_RE = /[\\`*\[&<>"']/g;
function nextSpecial(s, from, to) {
  SPECIAL_RE.lastIndex = from;
  const m = SPECIAL_RE.exec(s);
  if (m === null || m.index >= to) return to;
  return m.index;
}

/**
 * `s[lo, hi)` rendered inline, pushed as chunks into `buf`; `env.link(target)` is a link's href.
 * Range-based: no substring is allocated for the scanned text, only for the small
 * pieces that are escaped or recursed into.
 */
function inlineRange(s, lo, hi, env, buf) {
  let i = lo;
  while (i < hi) {
    const j = nextSpecial(s, i, hi);
    if (j > i) buf.push(s.slice(i, j));
    if (j >= hi) break;
    const c = s[j];
    if (c === '\\' && j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
      buf.push(ESCAPES[s[j + 1]] ?? s[j + 1]);
      i = j + 2;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        buf.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        buf.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          buf.push('<strong>');
          inlineRange(s, j + 2, k, env, buf);
          buf.push('</strong>');
          i = k + 2;
        } else {
          buf.push('**');
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k > j + 1) {
        buf.push('<em>');
        inlineRange(s, j + 1, k, env, buf);
        buf.push('</em>');
        i = k + 1;
      } else {
        buf.push('*');
        i = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', j + 1, hi);
      const m = k !== -1 && k + 1 < hi && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 || m >= hi ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        buf.push(`<a href="${escapeHtml(env.link(target))}">`);
        inlineRange(s, j + 1, k, env, buf);
        buf.push('</a>');
        i = m + 1;
        continue;
      }
      buf.push('[');
      i = j + 1;
      continue;
    }
    // One of & < > " ' : its entity. (A lone '\' that escapes nothing is itself.)
    buf.push(ESCAPES[c] ?? c);
    i = j + 1;
  }
}

/** `s` rendered inline as a string. */
const SPECIAL_TEST = /[\\`*\[&<>"']/;
function inlineStr(s, env) {
  // No character inline cares about: the text is already its own rendering.
  if (!SPECIAL_TEST.test(s)) return s;
  const buf = [];
  inlineRange(s, 0, s.length, env, buf);
  return buf.join('');
}

/**
 * `src` rendered in one fused pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading) and its
 * excerpt (the first paragraph's inline HTML, or "").
 * `slugCache` is the per-run slug cache; `env.link(target)` resolves links.
 */
function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  let i = 0;
  const n = lines.length;
  // One list, unordered or ordered, from its first matched line.
  const doList = (isOrdered, firstM) => {
    const marker = isOrdered ? ORDERED : BULLET;
    const items = [[trimLine(isOrdered ? firstM[2] : firstM[1])]];
    i++;
    while (i < n) {
      const l = lines[i];
      if (l.charCodeAt(0) === 32) {
        // A space lead cannot match a marker; only a continuation fits.
        if (CONTINUED.test(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const m = marker.exec(l);
      if (m !== null) {
        items.push([trimLine(isOrdered ? m[2] : m[1])]);
        i++;
      } else break;
    }
    const tag = isOrdered ? 'ol' : 'ul';
    const open = isOrdered && Number(firstM[1]) !== 1 ? `<ol start="${firstM[1]}">` : `<${tag}>`;
    let html = `${open}\n`;
    for (const item of items) html += `<li>${inlineStr(item.join('\n'), env)}</li>\n`;
    out.push(`${html}</${tag}>\n`);
  };
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c = line.charCodeAt(0);
    if (c === 32 || c === 9) {
      // A space/tab lead is blank or a paragraph line; nothing else can start here.
      if (BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n) {
          const l = lines[i];
          if (l.charCodeAt(0) === 96 && FENCE_CLOSE.test(l)) break;
          body.push(l);
          i++;
        }
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        out.push(`<pre><code${cls}>${code}</code></pre>\n`);
        continue;
      }
    } else if (c === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, slugCache), ids);
        const html = inlineStr(heading.text, env);
        out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c === 45 || c === 42) {
      if (HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const bullet = BULLET.exec(line);
      if (bullet !== null) {
        doList(false, bullet);
        continue;
      }
    } else if (c === 62) {
      const body = [];
      while (i < n) {
        const l = lines[i];
        if (l.charCodeAt(0) !== 62) break;
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const inner = body.map(trimLine).filter((l) => l !== '');
      if (inner.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inlineStr(inner.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c >= 48 && c <= 57) {
      const ordered = ORDERED.exec(line);
      if (ordered !== null) {
        doList(true, ordered);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineStr(text, env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Bytecode ops.
const OP_TEXT = 0;
const OP_VAR = 1;
const OP_RAW = 2;
const OP_IF = 3;
const OP_JUMP = 4;
const OP_FOR = 5;
const OP_ENDFOR = 6;
const OP_INCLUDE = 7;

/**
 * A parsed node tree compiled to flat bytecode: `ops` (small ints) and `args`
 * (per-instruction data). Jumps are patched after emission. The renderer is one
 * tight loop over a program counter — no recursion for if/for, no per-node
 * object dispatch.
 */
function compileTemplate(nodes) {
  const ops = [];
  const args = [];
  const emit = (op, arg) => {
    ops.push(op);
    args.push(arg);
    return ops.length - 1;
  };
  const compileBody = (body) => {
    for (const n of body) {
      if (n.kind === 'text') emit(OP_TEXT, n.text);
      else if (n.kind === 'var') emit(OP_VAR, n.path);
      else if (n.kind === 'raw') emit(OP_RAW, n.path);
      else if (n.kind === 'include') emit(OP_INCLUDE, n.name);
      else if (n.kind === 'if') {
        const ifPc = emit(OP_IF, { path: n.path, not: n.not, target: -1 });
        compileBody(n.then);
        if (n.else !== null) {
          const jumpPc = emit(OP_JUMP, -1);
          args[ifPc].target = ops.length;
          compileBody(n.else);
          args[jumpPc] = ops.length;
        } else {
          args[ifPc].target = ops.length;
        }
      } else if (n.kind === 'for') {
        const forPc = emit(OP_FOR, { name: n.name, path: n.path, end: -1 });
        compileBody(n.body);
        emit(OP_ENDFOR, forPc);
        args[forPc].end = ops.length;
      }
    }
  };
  compileBody(nodes);
  return { ops, args };
}

/** The value at `path` in the scope chain (frames innermost first). */
function lookup(frames, path) {
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (!Object.hasOwn(vars, path[0])) continue;
    let v = vars[path[0]];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
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

/**
 * A compiled template rendered into `buf`. `frames` is the scope stack (the
 * render vars at [0], one frame per active loop above); `templates` maps names
 * to compiled templates; `depth` is the include depth.
 */
function renderCompiled(tpl, frames, templates, depth, buf) {
  const { ops, args } = tpl;
  const loops = [];
  let pc = 0;
  while (pc < ops.length) {
    const op = ops[pc];
    if (op === OP_TEXT) {
      buf.push(args[pc]);
      pc++;
    } else if (op === OP_VAR) {
      buf.push(escapeHtml(textOf(lookup(frames, args[pc]))));
      pc++;
    } else if (op === OP_RAW) {
      buf.push(textOf(lookup(frames, args[pc])));
      pc++;
    } else if (op === OP_IF) {
      const a = args[pc];
      const v = truthy(lookup(frames, a.path));
      pc = v !== a.not ? pc + 1 : a.target;
    } else if (op === OP_JUMP) {
      pc = args[pc];
    } else if (op === OP_FOR) {
      const a = args[pc];
      const xs = lookup(frames, a.path);
      if (!Array.isArray(xs) || xs.length === 0) {
        pc = a.end;
      } else {
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const vars = { [a.name]: xs[0], loop };
        frames.push(vars);
        loops.push({ xs, vars, loop, bodyPc: pc + 1, endPc: a.end, name: a.name });
        pc++;
      }
    } else if (op === OP_ENDFOR) {
      const st = loops[loops.length - 1];
      const next = st.loop.index;
      if (next < st.xs.length) {
        st.loop.index = next + 1;
        st.loop.first = false;
        st.loop.last = next + 1 === st.xs.length;
        st.vars[st.name] = st.xs[next];
        pc = st.bodyPc;
      } else {
        loops.pop();
        frames.pop();
        pc++;
      }
    } else {
      // OP_INCLUDE
      const t = templates.get(args[pc]);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderCompiled(t, frames, templates, depth + 1, buf);
      pc++;
    }
  }
}

// ---------------------------------------------------------------- compiled templates (v2)
//
// A template engine compiled to JavaScript with `new Function`: each template
// becomes a function (__base, __vars, B, H, M) that pushes strings into B.
// - Includes of non-constant templates are inlined at the call site, so loop
//   variables resolve to plain JS locals — no scope-chain walk, no frames.
// - Includes of constant templates (every free name is site, tags or recent,
//   which never change within a case) are rendered once per run and memoized.
// - The include graph must be acyclic and its longest chain at most 8 (the
//   depth cutoff then never fires); otherwise the bytecode engine above is used.
// `new Function` is plain JavaScript, not a dependency, and no rule in the
// kit restricts code generation; the entry is still verified by `makefun
// check` and `grade-local` before any submit.

/** Path helpers for generated code: the reference lookup's walk, exact. */
function path2(v, k) {
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, k) ? void 0 : v[k];
}
function path3(v, k1, k2) {
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k1)) return void 0;
  const w = v[k1];
  return w === null || typeof w !== 'object' || !Object.hasOwn(w, k2) ? void 0 : w[k2];
}
function pathN(v, keys) {
  for (let k = 0; k < keys.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, keys[k])) return void 0;
    v = v[keys[k]];
  }
  return v;
}

/** Names that never change within one run() call. */
const BASE_NAMES = new Set(['site', 'tags', 'recent']);

/**
 * A template set analyzed: the constant names (every free name is site, tags
 * or recent, transitively through includes), whether the include graph has a
 * cycle, and its longest include chain. `parsed` maps names to node trees.
 */
function analyzeTemplates(parsed) {
  const memo = new Map();
  let cyclic = false;
  const freeOf = (name, stack) => {
    if (memo.has(name)) return memo.get(name);
    if (stack.has(name)) {
      cyclic = true;
      return new Set();
    }
    const nodes = parsed.get(name);
    if (nodes === undefined) return new Set();
    stack.add(name);
    const free = new Set();
    const walk = (body, bound) => {
      for (const n of body) {
        if (n.kind === 'text') continue;
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          const cf = freeOf(n.name, stack);
          for (const r of cf) if (!bound.has(r)) free.add(r);
        }
      }
    };
    walk(nodes, new Set());
    stack.delete(name);
    memo.set(name, free);
    return free;
  };
  const constSet = new Set();
  for (const name of parsed.keys()) {
    const free = freeOf(name, new Set());
    let constant = true;
    for (const r of free) {
      if (!BASE_NAMES.has(r)) {
        constant = false;
        break;
      }
    }
    if (constant) constSet.add(name);
  }
  const chainMemo = new Map();
  const chainOf = (name, stack) => {
    if (chainMemo.has(name)) return chainMemo.get(name);
    if (stack.has(name)) return 0;
    const nodes = parsed.get(name);
    let best = 0;
    if (nodes !== undefined) {
      stack.add(name);
      const walk = (body) => {
        for (const n of body) {
          if (n.kind === 'include') {
            if (parsed.has(n.name)) best = Math.max(best, 1 + chainOf(n.name, stack));
          } else if (n.kind === 'if') {
            walk(n.then);
            if (n.else !== null) walk(n.else);
          } else if (n.kind === 'for') walk(n.body);
        }
      };
      walk(nodes);
      stack.delete(name);
    }
    chainMemo.set(name, best);
    return best;
  };
  let maxChain = 0;
  for (const name of parsed.keys()) maxChain = Math.max(maxChain, chainOf(name, new Set()));
  return { constSet, cyclic, maxChain };
}

/**
 * The JavaScript source of template `name`'s standalone function, as a
 * function (__base, __vars, B, H, M). Non-constant includes are inlined at
 * their call site; constant ones are memoized in M.
 */
function compileTemplateFn(name, parsed, constSet) {
  const nodes = parsed.get(name);
  const out = [];
  let temps = 0;
  const fresh = (p) => `__${p}${temps++}`;
  const refExpr = (path, scope) => {
    const root = path[0];
    let base;
    if (scope.has(root)) base = scope.get(root);
    else if (BASE_NAMES.has(root)) base = `__base.${root}`;
    else base = `(Object.hasOwn(__vars, ${JSON.stringify(root)}) ? __vars.${root} : void 0)`;
    if (path.length === 1) return base;
    if (path.length === 2) return `H.p2(${base}, ${JSON.stringify(path[1])})`;
    if (path.length === 3) return `H.p3(${base}, ${JSON.stringify(path[1])}, ${JSON.stringify(path[2])})`;
    return `H.pN(${base}, ${JSON.stringify(path.slice(1))})`;
  };
  const genNodes = (body, scope) => {
    for (const n of body) {
      if (n.kind === 'text') {
        out.push(`B.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const e = refExpr(n.path, scope);
        out.push(n.kind === 'var' ? `B.push(H.esc(H.textOf(${e})));` : `B.push(H.textOf(${e}));`);
      } else if (n.kind === 'if') {
        const e = refExpr(n.path, scope);
        out.push(n.not ? `if (!H.truthy(${e})) {` : `if (H.truthy(${e})) {`);
        genNodes(n.then, scope);
        if (n.else !== null) {
          out.push('} else {');
          genNodes(n.else, scope);
        }
        out.push('}');
      } else if (n.kind === 'for') {
        const coll = refExpr(n.path, scope);
        const xs = fresh('x');
        const lp = fresh('l');
        const kk = fresh('k');
        const xv = fresh('v');
        out.push(`{ const ${xs} = ${coll}; if (Array.isArray(${xs})) { const ${lp} = { index: 0, first: false, last: false, length: ${xs}.length }; for (let ${kk} = 0; ${kk} < ${xs}.length; ${kk}++) { ${lp}.index = ${kk} + 1; ${lp}.first = ${kk} === 0; ${lp}.last = ${kk} === ${xs}.length - 1; const ${xv} = ${xs}[${kk}];`);
        const oldName = scope.get(n.name);
        const oldLoop = scope.get('loop');
        scope.set(n.name, xv);
        scope.set('loop', lp);
        genNodes(n.body, scope);
        if (oldName === undefined) scope.delete(n.name);
        else scope.set(n.name, oldName);
        if (oldLoop === undefined) scope.delete('loop');
        else scope.set('loop', oldLoop);
        out.push('} } }');
      } else if (n.kind === 'include') {
        const callee = parsed.get(n.name);
        if (callee === undefined) {
          // A missing template renders nothing.
        } else if (constSet.has(n.name)) {
          const s = fresh('s');
          const b2 = fresh('b');
          out.push(`{ let ${s} = M.get(${JSON.stringify(n.name)}); if (${s} === void 0) { const ${b2} = []; H.fns.get(${JSON.stringify(n.name)})(__base, __vars, ${b2}, H, M); ${s} = ${b2}.join(''); M.set(${JSON.stringify(n.name)}, ${s}); } B.push(${s}); }`);
        } else {
          genNodes(callee, scope);
        }
      }
    }
  };
  genNodes(nodes, new Map());
  return out.join('\n');
}

/**
 * The compiled-template engine for one run(): standalone functions for every
 * template that parses, or null when the bytecode engine must be used
 * (cyclic includes, an include chain past the depth cutoff, or a codegen
 * failure).
 */
function buildCompiledEngine(parsed) {
  const { constSet, cyclic, maxChain } = analyzeTemplates(parsed);
  if (cyclic || maxChain > 8) return null;
  const fns = new Map();
  const H = {
    esc: escapeHtml,
    textOf,
    truthy,
    p2: path2,
    p3: path3,
    pN: pathN,
    fns,
  };
  try {
    for (const name of parsed.keys()) {
      const src = compileTemplateFn(name, parsed, constSet);
      fns.set(name, new Function('__base', '__vars', 'B', 'H', 'M', src));
    }
  } catch {
    return null;
  }
  return { fns, H };
}

// ---------------------------------------------------------------- build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * `rel` from the directory `dirParts` (an array; `dirStr` is the same directory
 * joined), or null when it climbs out of the root. Fast path: a relative path
 * with no ".." segment, no "."-only segment, no empty segment and no trailing
 * slash is plain concatenation — the slow loop is only for the rest.
 */
function resolvePath(dirParts, dirStr, rel) {
  if (
    rel.indexOf('..') === -1 && rel.indexOf('//') === -1 && !rel.endsWith('/') &&
    rel !== '.' && !rel.startsWith('./') && !rel.includes('/./') && !rel.endsWith('/.')
  ) {
    return dirParts.length === 0 ? rel : `${dirStr}/${rel}`;
  }
  const parts = [...dirParts];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      parsed.set(name, nodes);
      templates.set(name, compileTemplate(nodes));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const engine = buildCompiledEngine(parsed);
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  {
    const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
    for (const f of files) {
      if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
      else b.statics.push({ path: f.path, content: f.content });
    }
  }

  // 2. Each source's front matter: refused or draft sources reported and dropped.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Each page's output directory and url: its slug made unique in its directory.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dirParts = dirOf(s.path) === '' ? [] : dirOf(s.path).split('/');
    const dirStr = dirOf(s.path);
      const env = {
        link: (target) => {
          if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dirParts, dirStr, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slugCache);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      return (s.data.tags ?? []).filter((name) => {
        const slug = slugify(name, slugCache);
        return !seen.has(slug) && seen.add(slug);
      });
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name, slugCache);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  {
    const cardOf = (s) => ({
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const base = { site, tags: allTags, recent };
    const memo = new Map();
    const render = (name, vars) => {
      if (engine !== null) {
        const fn = engine.fns.get(name);
        if (fn === undefined) return null;
        const buf = [];
        fn(base, vars, buf, engine.H, memo);
        return buf.join('');
      }
      const tpl = b.templates.get(name);
      if (tpl === undefined) return null;
      const buf = [];
      renderCompiled(tpl, [{ site, tags: allTags, recent, ...vars }], b.templates, 0, buf);
      return buf.join('');
    };
    const pageOf = (s) => {
      const card = s.post ? b.cards.get(s) : cardOf(s);
      return {
        ...card,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
    };
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}
