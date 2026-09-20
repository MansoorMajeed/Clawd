---
name: summarize
description: "Fetch a URL or convert a local file (PDF/DOCX/HTML/etc.) into Markdown using `uvx --python 3.12 markitdown`, optionally it can summarize"
---

Turn “things” (URLs, PDFs, Word docs, PowerPoints, HTML pages, text files, etc.) into **Markdown** so they can be inspected/quoted/processed like normal text.

`markitdown` can fetch URLs by itself; this skill mainly wraps it to make saving + summarizing convenient.
For PDF inputs, use the `markitdown[pdf]` extra (or the wrapper below, which now does this automatically).

## When to use

Use this skill when you need to:
- pull down a web page as a document-like Markdown representation
- convert binary docs (PDF/DOCX/PPTX) into Markdown for analysis
- quickly produce a short summary of a long document before deeper work

## Quick usage

### Convert a URL or file to Markdown

Run from **this skill folder**. Resolve local files to absolute paths before changing directories so they still point to the intended input:

```bash
INPUT=/absolute/path/to/document.pdf
cd /path/to/this/skill
node to-markdown.mjs "$INPUT" --tmp

# URLs can be passed directly
uvx --python 3.12 --from 'markitdown[pdf]' markitdown <url-or-path>
```

To write Markdown to a temp file (prints the path) use the wrapper:

```bash
node to-markdown.mjs <url-or-path> --tmp
```

Tip: when summarizing, the script will **always** write the full converted Markdown to a temp `.md` file and will **always** print a final "Hint" line with the path (so you can open/inspect the full content).

Write Markdown to a specific file:

```bash
uvx --python 3.12 --from 'markitdown[pdf]' markitdown <url-or-path> > /tmp/doc.md
```

### Convert + summarize with haiku-4-5 (pass context!)

Summaries are only useful when you provide **what you want extracted** and the **audience/purpose**.

```bash
node to-markdown.mjs <url-or-path> --summary --prompt "Summarize focusing on X, for audience Y. Extract Z."
```

Or:

```bash
node to-markdown.mjs <url-or-path> --summary --prompt "Focus on security implications and action items."
```

This will:
1) convert to Markdown via `uvx --python 3.12 --from 'markitdown[pdf]' markitdown`
2) write the full Markdown to a temp `.md` file and print its path as a "Hint" line
3) stream the converted Markdown to Pi over stdin, avoiding OS argument-length limits
4) run `pi --model claude-haiku-4-5` with tools, extensions, skills, prompt templates, context files, and session persistence disabled so unrelated child resources do not affect a document-only summary

For very long documents, the wrapper retains the full converted Markdown in the reported temp file but sends at most 140,000 characters (the beginning and end) to the summarizer and labels the truncation. Inspect or process the full temp file when omitted middle content matters.
