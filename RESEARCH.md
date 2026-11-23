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

## v2 (2026-11-23) — chasing top 10

v1 measured ~147 ms local (median, 10 iters) vs reference ~584–624 ms (~3.9x).
Dev-phase top-10 cutoff is 360,000 µs; v1's server estimate (~407,000 µs) sits
outside it. v2 target: clearly faster than v1, same byte-exact output.

16. **First-char block dispatch** — CHOSEN (Stage A). `renderMarkdown`'s block loop
    called the same regexes in sequence per line. Now the first char dispatches:
    blank/space-tab → blank-or-paragraph, backtick → fence, `#` → heading,
    `-`/`*` → HR then bullet, `>` → quote, digit → ordered, else paragraph.
    Precedence preserved from the reference; `endsParagraph` and the
    list/fence/quote inner loops dispatch the same way.
17. **`wordsOf` counts word ends, not starts** — CHOSEN (Stage A). The v1 manual
    scan counted word starts (inWord state per char). Counting a word end — a
    whitespace char preceded by a non-whitespace char — plus one when the text
    ends on a word char, with a printable-ASCII skip, is exact (verified against
    `match(/\S+/g)` on all 1,070 practice bodies + edge cases incl. \v \f \u00a0
    \u2003 \u2028 \u2029 \uFEFF surrogate pairs) and ~17% faster in isolation
    (15.7 ms vs 18.9 ms on 2.77M chars).
18. **`slugify` ASCII fast path** — CHOSEN (Stage A). ASCII normalises to itself
    under NFKD and carries no combining marks, so a pre-scan loop that aborts on
    the first non-ASCII char lets ASCII titles skip `normalize` + the `\p{M}`
    regex entirely; non-ASCII falls back to the full path.
19. **`resolvePath` fast path + precomputed `dirStr`** — CHOSEN (Stage A). When a
    relative target has no `..` segment, no `.`-only segment, no `//` and no
    trailing `/`, the resolved path is a plain concatenation; the source dir
    string is precomputed once per source.
20. **Stage A result** — ~130 ms local (mean of 3 rounds), ~14.5% faster than v1,
    still 3/3 byte-exact.
21. **`new Function` template compiler** — CHOSEN (Stage B), reversing v1's
    rejection #12. Re-verified before adopting: no codegen/eval/`new Function`
    ban anywhere in RULES.txt, competition.yaml, the scorer or the harness
    (grep for eval / `new Function` / codegen came back empty). Each template
    becomes a JS function `(__base, __vars, B, H, M)`; non-constant includes are
    inlined at the call site (loop vars become plain JS locals, scope map with
    save/restore, fresh temp names); constant templates (free names ⊆ {site,
    tags, recent}, computed transitively with scope-aware analysis) are rendered
    once per run and memoized in a per-run Map; `for` uses one mutated loop
    object per loop (safe — templates only read it). The include graph must be
    acyclic with longest chain ≤ 8, or the v1 bytecode engine (kept intact in
    the file) is used as fallback; any codegen failure also falls back.
22. **Stage B result** — ~118.7 ms local, ~9% over Stage A, ~22% over v1, 3/3
    byte-exact. Template rendering fell from ~19% of profile to ~9.5%.
23. **Inline no-specials fast path** — CHOSEN. `inlineStr` returns the text as-is
    when it holds no character from `[\\` *\[&<>"']` (exact: inlineRange would
    only push plain runs). Headings and blockquotes now go through `inlineStr`
    too instead of calling `inlineRange` directly. Only ~21% of paragraphs hit
    it (bodies are rich in emphasis/code/links), so the gain is modest.
24. **Word-count fusion into `renderMarkdown`** — REJECTED after A/B. Counting
    words per line from the already-split lines array is exact (1,070/1,070
    bodies + edge cases vs the reference regex) but measured ~4% SLOWER than the
    separate `wordsOf` pass: the per-line function-call overhead beats the cache
    benefit on this machine. Kept the separate `wordsOf`.
25. **Shared scratch buffers for `inlineStr`/`render`** — REJECTED. A/B showed no
    measurable gain (within machine noise); not worth the reentrancy risk.
    Reverted.
26. **Lazy / reachable-only template compilation** — REJECTED. Only ~40% of the
    compile cost is the `new Function` calls (the rest is the analysis the memo
    logic needs anyway), and ~11 templates per case are unused decoys; the
    saving would be ~0.5% of total. Not worth restructuring `run()`.
27. **Final v2** — ~110.7 ms local (mean of 4 alternating A/B rounds, 10 iters
    each) vs v1 ~146.7 ms: **~24.5% faster**, 3/3 byte-exact. Ratio vs reference
    ~5.3x → server estimate ~300,000 µs, inside the 360,000 µs top-10 cutoff
    with ~17% margin. SUBMITTED as entry 2 (Force_Last replaces v1) 2026-11-23
    15:30 WIB: submission 01a20787-271f-75b9-b87b-88c9a77e50f7 ("Elegant Atlas"),
    commit e2799bc, checked, all validity checks pass, dev grading underway.
    Entries close Wed 25 Nov 03:00 WIB; result due 9 Dec 20:00 WIB.
