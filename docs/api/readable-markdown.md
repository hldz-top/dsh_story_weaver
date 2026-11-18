---
description: "Inert, readable Markdown for recorded prose, findings, quotations and provenance in document previews."
---
# Readable Markdown

## Summary

[The readable Markdown module](../../src/readable-markdown.ts) turns recorded text into Markdown that the Host document preview shows as ordinary text. [Artifact previews](../../src/artifact-markdown.ts) use it for chapter prose, outlines, settings content, review findings, research questions and conclusions, quotations and provenance. [Rejected-output previews](stage-deliveries.md) use it for the admission failure and provenance. Only the raw model response of a rejected output stays in a code block, because it is machine output (JSON).

## Functions

| Function | Output |
| --- | --- |
| `readableText(text)` | Paragraphs. A blank line separates paragraphs and a single line break becomes a Markdown hard break. Blank input returns an empty string. |
| `quotedText(text)` | The same content as a blockquote, used for cited evidence and source excerpts. |
| `readableList(items)` | One bullet per entry, used for provenance. |
| `literalTextBlock(text)` | Machine output, such as a raw rejected model response, verbatim inside a `text` fence longer than any backtick run in it. |

## Inertness

Recorded text is data, not document structure. Every character that can start a Markdown, GFM, HTML or math construct is written as a numeric character reference such as `&#35;` for `#`. CommonMark always decodes these references to literal text. The encoded characters are `` \ ` * ~ [ ] < > & $ | # ``, an underscore at a word boundary, a line-start `-`, `+`, `=` or ordered-list delimiter, and the web-address triggers described below. Backslash escapes are not used. The Host preview grammar treats `\(` and `\[` as TeX math delimiters, so an escaped bracket would start math.

Leading spaces and tabs become no-break spaces, so indentation stays visible without starting an indented code block. Trailing spaces are dropped, so they cannot form a line break. An underscore between letters or digits cannot open or close emphasis and is kept, so identifiers such as `artifact_…` stay searchable in the raw file.

### Web addresses

GFM recognizes `http://`, `https://`, `www.` and e-mail literals in two places: while tokenizing the raw source, and again in the decoded text afterwards. A literal recognized during tokenization would absorb the character references that follow it. For example, `&#38;` would become part of both the visible address and its destination. The tokenizer triggers are therefore encoded too: the `:` in `://`, the `.` after `www` and every `@`. Tokenizing then never starts a literal, and GFM's second pass links the address in the decoded text with exactly its visible characters, including `&`, `#`, `_` and parentheses. Only such bare web and e-mail addresses become links, labelled with their own text. Model text cannot choose a link label or target, and it cannot produce an image.

`tests/readable-markdown.spec.ts` checks these properties with the parser the DSH preview uses: `mdast-util-from-markdown`, `micromark-extension-gfm`, `mdast-util-gfm`, `micromark-extension-math` and `mdast-util-math`. They are pinned as dev dependencies at the versions bundled into DSH 0.2.0-rc.2, so the checks run everywhere.

Settings and outline `contentMarkdown` is model-written Markdown. It is shown with its markers as literal text rather than rendered, so a forged heading or link cannot alter the preview document.

## Existing preview files

Opening a preview publishes the current rendering. An allocated input or reviewed reference is labeled `Input ID` or `Reviewed ID` with its eight-character project id. `Artifact SHA-256` and `Recorded source SHA-256` stay full content digests. A file that exactly matches that current text is reused. A file that exactly matches an earlier derived rendering — the fenced form from [`legacyArtifactMarkdown`](../../src/artifact-markdown.ts), or the readable form that labeled those references with a full SHA-256 — is replaced in place with the current text. The stored artifact is not modified. Any other bytes are a user edit: that file is left verbatim, and the current projection is written to a separate `*.current.md` path (or a later `*.current-N.md` path when that file was edited too). The caller receives the current projection path. Deleting the old file is not required.
