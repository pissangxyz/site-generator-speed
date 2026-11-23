# Research note — site-generator-speed-01 (makefun-site 1.0.0 drop-in)

## What the reference costs (measured locally, 3 practice cases, CPU ms per case)

| plugin | g-0001 | g-0002 | g-0003 | share |
|---|---|---|---|---|
| markdown | 222 | 200 | 237 | ~65–70% |
| layouts (template render) | 44 | 105 | 41 | ~15–30% |
| frontMatter | 8 | 9 | 21 | ~3–6% |
| rest (sources, permalinks, collections, tags, report) | ~9 | ~10 | ~13 | ~3% |

Total reference ≈ 283–324 ms/case locally (≈ 920 ms for the set).

## Angles considered

1. **Fused Markdown (lex + render in one pass)** — CHOSEN. The reference lexes into
   token objects, then renders in a second pass. Fusing removes all token allocation
   and the second walk. Blocks render straight into the output buffer.
2. **Chunked inline escaping** — CHOSEN. The reference calls `escapeHtml(c)` on EVERY
   character. The scanner instead jumps from one special character to the next with a
   single regex search; the plain runs between specials need no escaping at all.
   Expected to be the single biggest win inside Markdown.
3. **Range-based inline recursion (no slicing)** — CHOSEN. `inline(s, lo, hi)` works on
   index ranges instead of `s.slice(...)`, so nested strong/em/link/code never
   allocate substrings. Only the final escaped chunk is materialised.
4. **Template bytecode compiler** — CHOSEN. The reference walks a node tree with a
   recursive `renderNodes` call per `if`/`for`/`include`. Templates are compiled once
   per case into a flat instruction array (TEXT/VAR/RAW/IF/JUMP/FOR/ENDFOR/INCLUDE)
   executed by a tight `pc` loop — no recursion for `if`/`for`, no per-node object
   dispatch. Scope stays the reference's chain model (frames array, innermost first),
   so lookup semantics are identical.
5. **Slug cache (per run)** — CHOSEN. `slugify` does NFKD + a `\p{M}` regex + a char
   loop. Titles respell, tag names (38 fixed names) and headings repeat heavily across
   the 200–600 sources. A per-`run()` Map turns repeats into a lookup. Cache is
   created inside `run()` — nothing survives from one case to the next.
6. **Index-based front matter** — CHOSEN. The reference `split('\n')`s the whole body
   and joins it back. The close `---` line is found with `indexOf`, the header region
   alone is split, the body is a single `slice`. Same errors, same line numbers.
7. **Manual word counting** — CHOSEN. `wordsOf` used `/\S+/g` (allocates an array of
   every word). A char scan counting word starts, with an ASCII fast path and a
   `\s` fallback only for non-ASCII chars, is exact and allocation-free.
8. **`\r` fast path in readSources** — CHOSEN. Only ~5% of files carry CRLF; skip the
   regex replace when the text holds no `\r`.
9. **Code-block escaping in one call** — CHOSEN. Escaping is per-character, so
   escaping the joined lines + one `\n` equals escaping each line + `\n`.
10. **Reuse the post's card object in `pageOf`** — CHOSEN. The reference builds
    `cardOf` twice for posts (once for the cards map, once inside `pageOf`). Same
    values, one build.
11. **Lazy cards** — REJECTED. With per_page 5–15 and ~96 index pages plus tag
    pages, essentially every post's card is rendered; laziness saves nothing.
12. **`new Function` code generation for templates** — REJECTED. A bytecode loop is
    fast enough and avoids any sandbox code-generation restriction.
13. **Caching across cases** — FORBIDDEN by the rules ("nothing cached from one case
    to the next"). All memoisation lives inside one `run()` call.
14. **Skipping work for drafts/refusals** — already minimal; the checks are cheap
    string/regex tests and must run in order for the report.
15. **Pre-resolving template paths at compile time** — REJECTED. Paths resolve
    against loop frames that only exist at render time; the frame walk is 1–3 frames
    and already cheap.

## Expected shape

Markdown ~3x faster (fused + chunked escaping + range inline), layouts ~3x faster
(bytecode vs tree-walking interpreter), front matter ~2x. Total target ≈ 2.5–3x
faster than the reference on the same machine.
