---
description: "Novel-writing terms for settings, reviewed chapters and continuity in DSH."
---
# Novel-writing context

## Summary

This glossary defines the novel-writing terms used by the [plugin specification](spec.md). It distinguishes planned events, written events and the versions that guide subsequent writing.

## Table of Contents

- [Language](#language)
- [Dev Note](#dev-note)

<a id="language"></a>

## Language

**Novel project**: A novel's creative requirements, settings, outlines, chapters and writing history. A conversation can work on a novel without becoming the novel's identity.

**Settings**: The agreed creative constraints, world facts and character definitions that guide the story. A settings dimension is one named part of these settings.

**Classification dimension**: A settings dimension that selects one or more catalog labels, such as genre, audience, tone or time-and-place setting. It records the selected labels, brief grounds and only the constraints later writing must honor. Detailed world facts belong to world-building dimensions.

**Book outline**: The intended story structure, chapter purposes, development of characters and resolution of the story.

**Chapter outline**: The intended events and scenes of one chapter, including the obligations that its body must fulfill. Planned events are not evidence that those events have occurred.

**Body**: The reader-facing prose of a chapter. Titles, review reports and chapter outlines are separate from the body.

**Candidate**: A generated or revised output that has not been formally applied. A candidate remains a candidate even when its generation task has finished.

**Applied version**: The formally adopted output of a writing stage. Dependent writing uses this version only while its recorded inputs remain current.

**Blocking issue**: A detected violation that prevents an output from being applied, such as a chapter outside its length range, an omitted required event or a continuity contradiction.

**Advisory issue**: A suggested improvement that does not prevent application, such as optional wording, rhythm or style changes.

**Writing obligation**: A required event, payoff or constraint assigned to a chapter or story segment. Its completion requires evidence from written prose.

**Continuity state**: The established story facts after an applied chapter: actual events, character state, chronology and outstanding obligations. Chapter plans do not establish these facts.

**Continuity snapshot**: A compact reviewed note taken after a chapter is applied: character status, unrecovered foreshadowing and used plot bridges. Later chapters read these notes. The snapshot is not a narrative-state graph and it is not applied until its own review passes.

**Needs update**: An existing output whose upstream inputs have changed. Its history remains readable while its suitability for subsequent writing requires review.

**Writing run**: One requested sequence of writing work with an explicit target stage or chapter range. A run can finish, pause, stop or fail without erasing earlier applied chapters.

<a id="dev-note"></a>

## Dev Note

These terms describe the agreed product requirements. They do not assert that the plugin is implemented.
