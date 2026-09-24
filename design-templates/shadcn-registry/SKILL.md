---
name: shadcn-registry
description: Start a shadcn project from registry addresses instead of vendored Studio source.
triggers:
  - "shadcn block"
  - "shadcn theme"
  - "studio block"
od:
  mode: prototype
  category: web-artifacts
  preview:
    type: html
  design_system:
    requires: false
  example_prompt: |
    Create a Next.js project with components.json, then add the registry items
    named in example.html. Do not copy React blocks into this catalogue.
---

# shadcn registry starter

This template lists registry addresses. It does not vendor Studio blocks, pages, or illustrations.

Add them with the shadcn CLI inside the generated project:

- `@shadcn/button`
- `@shadcn-studio/button-01`
- `@ss-themes/art-deco`
- `@ss-blocks/<name>`
- `@ss-pages/<name>`
- `@ss-illustrations/<name>`

The Studio admin dashboard is a Next app, not this template.
