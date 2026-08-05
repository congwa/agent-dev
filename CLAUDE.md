# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is **not a code project** — it is a personal research-notes knowledge base about AI agent development, written in Chinese. There is no build system, no tests, no lint, and no dependencies. The deliverables are markdown documents.

## Structure

- One folder per topic series, named `YYYY-MM_中文标题` (e.g. `2026-07_agent当前发展`); the month is when the series was written. Multiple series in the same month get separate folders.
- Documents inside each folder are numbered: `1_xxx.md`, `2_xxx.md`, …
- `README.md` at the repo root is the Chinese-language index. Ordering rule: **AI/agent-related series always come first** (so readers see them before anything else), then backend series in reverse-chronological order; within each folder's table the documents are listed in descending number order (15, 14, … 1). Each folder gets a short Chinese description plus a table of its documents. Keep the README lean — no reading-order footnotes or per-row tags that repeat what the description already says. **Whenever a document or folder is added, renamed, or removed, update README.md to match.**

## Writing conventions (follow these when adding or editing notes)

The existing documents follow a deliberate research methodology worth preserving:

- **Date-stamp research**: documents record when the investigation was done (e.g. "调研时间：2026-07-29") and note that star counts / commit dates were measured on that day. Use absolute dates, never relative ones.
- **First-hand verification over secondhand claims**: existing notes clone repos and verify against actual source code, and say so. When a claim comes from a third-party source that couldn't be cross-checked against official/primary material, it is explicitly flagged inline (e.g. "第三方来源、未经官方确认"). Maintain this distinction — never present unverified claims as confirmed.
- **Lead with conclusions**: documents open with a one-sentence takeaway ("一句话结论") and summary tables before diving into detail. Counterintuitive findings are called out explicitly.
- **Language**: documents are written in Chinese, with technical terms, project names, and code identifiers kept in English.
- **Tutorials start from a concrete scenario**, not definitions (see `singleflight入门教程.md`).
