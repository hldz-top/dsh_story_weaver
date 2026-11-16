---
description: "Exact chapter assembly, Story-compatible word counting, and blocking chapter-length findings."
---
# Body text

## Summary

[The body text module](../../src/body-text.ts) assembles validated scene prose, counts the assembled chapter, and reports whether its length falls inside the host's inclusive bounds. It performs no model calls, persistence, truncation, or application. [Stage-output parsing](stage-output.md) owns input versions, chapter identity, and ordered scene completeness before this module receives `BodyOutput`.

## Table of Contents

- [Assembly](#assembly)
- [Counting](#counting)
- [Length inspection](#inspection)
- [Advisory review metrics](#advisory-metrics)
- [Integration](#integration)
- [Dev Note](#dev-note)

<a id="assembly"></a>
## Assembly

`assembleBody(output: BodyOutput): string` joins `output.scenes` in their existing order with exactly two line-feed characters (`\n\n`) between each pair. Each scene's `text` is preserved exactly, including leading and trailing whitespace, existing paragraphs, and CRLF line endings. A single scene returns its text unchanged. Existing trailing or leading newlines are not removed before joining.

`BodyOutput` contains no chapter title. The function adds no title, scene heading, identifier, input reference, or review text to the reader-facing body. It does not mutate the input.

<a id="counting"></a>
## Counting

`countStoryWords(text: string): number` counts each matching token once using the current Story `app/services/writing_pipeline/body_tools.py` and `lifecycle_harness.py` rule, inspected on 2026-09-11:

```text
[\u3400-\u4dbf\u4e00-\u9fff]|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*
```

| Text component | Count |
| --- | --- |
| Each character in U+3400–U+4DBF or U+4E00–U+9FFF | One. Other Unicode ideograph ranges are excluded by this rule. |
| A contiguous ASCII letter/digit word | One. Letters and digits may appear in the same word. |
| ASCII words joined by an internal straight apostrophe, right single quotation mark, or hyphen | One, including `can't`, `O’Neil`, `well-known`, and `2026-09-11`. |
| Repeated separators or other punctuation between ASCII words | Separate words: `a--b`, `a—b`, and `a_b` each count as two. |
| Whitespace, punctuation, or emoji without a matching token | Zero. |

This counter applies to the supplied text as written. It does not parse Markdown, estimate model tokens, or broaden the recognized character ranges. Callers pass only assembled prose; titles and reports must remain separate.

<a id="inspection"></a>
## Length inspection

`inspectBody(output: BodyOutput, bounds: BodyWordBounds): BodyInspection` assembles the exact text, measures it, and returns an explicit length finding. There are no default bounds. Both fields must be positive safe integers, and `minChapterWords` must not exceed `maxChapterWords`. Invalid limits throw `RangeError` before any acceptance result is returned.

| Field | Meaning |
| --- | --- |
| `bounds.minChapterWords` | Inclusive lower limit for the complete chapter. |
| `bounds.maxChapterWords` | Inclusive upper limit for the complete chapter. |
| `result.text` | The exact result of `assembleBody(output)`, including for rejected lengths. |
| `result.wordCount` | The result of `countStoryWords(result.text)`. |
| `result.length.status` | `too-short`, `within-range`, or `too-long`. |
| `result.length.blocking` | `true` for either violation; `false` only for `within-range`. |

With bounds 3000–5000, 2999 and 5001 are blocking, while 3000 and 5000 are within range. Inspection enforces no per-scene ceiling. Short and long candidates remain intact for review and repair; a failed length check never truncates or silently accepts them. A within-range result establishes length only, not substantive review acceptance.

<a id="advisory-metrics"></a>
## Advisory review metrics

`countHanChars` counts the Han tokens of the Story counter and skips its ASCII words. [review-metrics.ts](../../src/review-metrics.ts) uses that count as `wordCount`. `dialogueRatio` divides Han characters inside `「」` and `“”` by `wordCount`. `hookWindow`, `beatPositions`, and `eventHits` are measured from the assembled chapter, the previous snapshot, and the brief and settings. A version-11 body review receives them as `task.metrics` with the recorded `metricsBlocking` flag. The default flag is false. These figures do not change length admission or the required-event repair instruction, and they are not written into outline schemas.

<a id="integration"></a>
## Integration

The host supplies configured bounds, parses the model's body candidate, then inspects the complete assembled chapter after generation and every repair. It records the count and blocking finding against that exact candidate version. Review and application must use that same version; required-event, settings, persona, and continuity findings remain independent completion requirements. The module does not choose models, apply chapter state, or infer that planned events occurred.

<a id="dev-note"></a>
## Dev Note

The counter preserves Story's published-metrics tokenization. DSH Story's approved [specification](../specs/story-writing-plugin/spec.md) owns blocking chapter-length enforcement and configurable limits.
