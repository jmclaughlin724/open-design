---
name: render-probe
description: |
  Verify a generated HTML file contains the heading or control you just wrote.
  Use after generating or editing a page, before finishing, to probe one
  selector or capture a screenshot.
triggers:
  - "render probe"
  - "probe the page"
  - "verify the heading"
  - "check the html rendered"
  - "does the page contain"
od:
  mode: utility
  category: web-artifacts
---

# Render probe

After you generate or edit HTML, probe the file before you finish. Confirm the
entry route contains the heading you wrote, then probe one interaction
selector (a button, link, or input). Do not ship on the assumption that the
write succeeded.

## How to invoke

Prefer the MCP tool `renderProbe`.

- `file`: project-relative HTML path, such as `index.html`.
- `expression`: a selector expression, not JavaScript. Required unless `screenshot` is true.
- `screenshot`: when true, capture a headless Chromium PNG of the file and return its path under the project artifacts directory. Selector evaluation still does not run scripts.

Omit `project` to use the project the user has open.

On a runtime without that tool:

```
od probe <project> --file <path> --eval <expression> --screenshot --json
```

## Expressions

- `document.querySelector("h1").textContent`
- `text("h1")` or a bare selector such as `h1` or `#probe-heading`
- `heading` for the first heading text
- `heading("Expected text")` for an exact heading assertion
- `exists("button")` for a presence check

## How to read the result

The probe reads project file bytes and evaluates the selector. It does not run
scripts, apply the preview bridge, or compute layout. When `screenshot` is
true, the PNG path is `screenshot`. A false or unmatched result is still a
successful evaluation — inspect `matched` and `value`. Fix the file and probe
again. Stop only when the heading matches and the interaction selector exists.
