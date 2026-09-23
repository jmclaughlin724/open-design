---
name: absorb-claude-design
description: |
  Import a Claude Design ZIP or loose HTML file, extract its design-context
  digest, and iterate from that digest instead of restyling from memory.
  Use before changing an absorbed page, deck, or prototype.
triggers:
  - "absorb claude design"
  - "import claude design"
  - "design context"
  - "restyle this html"
  - "what is in this absorbed page"
od:
  mode: utility
  category: web-artifacts
---

# Absorb Claude Design

Turn an imported Claude Design artifact into context you can iterate on. Do
not restyle an absorbed file until you have read its design-context digest.

## Loop

1. Import. Put the ZIP or loose HTML into an existing project:

   ```
   od import claude-design <file...> --project <id> --json
   ```

   Use the importer's entry file. Do not assume `index.html` is the richest
   artifact.

2. Normalize. Keep the imported paths. Do not rewrite the file into a new
   layout before you know its structure.

3. Extract. Ask for the design-context digest before any restyle. Prefer the
   MCP tool `getDesignContext` with `file` set to the project-relative HTML
   path. Omit `project` to use the project the user has open.

   On a runtime without that tool:

   ```
   od context design <project> --file <f> --json
   ```

   The document has `headings`, `cssCustomProperties`, and `imagePaths`. Treat
   that as the brief: structure, palette, and referenced assets. The CLI also
   writes `context/design-context.json`; the MCP tool returns the same
   document without a separate write.

4. Iterate. Change the absorbed file against that digest. Preserve headings
   and custom properties you were not asked to replace. After the edit,
   extract again and confirm the digest still matches the request.

If the project has an active design system, run the design-system check after
the restyle. Do not invent tokens that the digest or the package does not
already declare.
