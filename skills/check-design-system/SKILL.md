---
name: check-design-system
description: |
  Check generated HTML and CSS against the active design-system token contract
  after writing design output. Use when a run just emitted tokens, colors, or
  component CSS and must not ship unknown or undeclared custom properties.
triggers:
  - "check design system"
  - "check tokens"
  - "unknown token"
  - "design system check"
  - "token contract"
od:
  mode: utility
  category: design-systems
---

# Check design system

Run this after writing design output, before you tell the user the artifact is
done. The check compares the project's active `tokens.css` with generated
HTML/CSS and reports tokens the package does not declare.

## When to run

- You just wrote or edited HTML, CSS, JSX, or TSX that uses `var(--*)`.
- You pasted or rewrote a `:root` token block.
- The user asked whether the design system still holds.

Skip it only when the project has no active design system. Say that plainly
instead of inventing a package.

## How to invoke

Prefer the MCP tool `check_design_system`. Omit `project` to use the project
the user has open. Pass `project` only when you are checking a different one.

On a runtime without that tool, run:

```
od design-system check <project> --json
```

A nonzero exit means the report has violations. Read `violations`, do not
treat the command as a transport failure.

## How to fix

1. Read each violation. `unknown-token` is not in the schema. `undeclared-reference` is allowed by the schema or brand extension but missing from the active package. `missing-schema-token` is a required token the package does not declare.
2. Change the generated file to use a token the active package already declares. Do not add a new custom property to paper over a violation.
3. If the violation is in `tokens.css` itself, fix the package, then re-run the check against the project files.
4. Re-run until `ok` is true. Quote the remaining token and file if you stop early.
