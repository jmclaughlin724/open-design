---
name: shadcn-ui
description: Install shadcn registry items with the CLI. Use for components, blocks, themes, fonts, and Studio namespaces.
triggers:
  - "shadcn"
  - "shadcn ui"
  - "shadcn components"
  - "shadcn studio"
od:
  mode: design-system
  category: design-systems
  upstream: "https://ui.shadcn.com/docs/cli"
---

# shadcn-ui

The install API is the shadcn CLI plus registry JSON. There is no separate SDK.

Run these commands only when the active project has its own `components.json`. Refuse the Open Design product repository. Do not write `apps/web/src/index.css`.

## Item types

`registry:base`, `registry:theme`, `registry:style`, `registry:ui`, `registry:component`, `registry:block`, `registry:page`, `registry:file`, `registry:font`, `registry:hook`, `registry:lib`, `registry:item`.

A `registry:base` item with no `cssVars` is an init preset, not a theme. The Studio components.json URL is that preset. Import themes from a token-bearing item such as `@ss-themes/art-deco`.

## Studio namespaces

| Namespace | Holds |
| --- | --- |
| `@shadcn-studio` | Free components, blocks, and themes |
| `@ss-components` | Free and premium components |
| `@ss-blocks` | Free and premium blocks |
| `@ss-pages` | Free and premium pages |
| `@ss-illustrations` | Free and premium illustrations |
| `@ss-themes` | Free, premium, and user-generated themes |

Premium items need `EMAIL` and `LICENSE_KEY` in the target project environment. Never commit those values and never attach them from this repository.

## Commands

Inside the target project:

```bash
pnpm dlx shadcn@latest init --template next --base base --preset nova
pnpm dlx shadcn@latest add @shadcn/button
pnpm dlx shadcn@latest add @ss-themes/art-deco
pnpm dlx shadcn@latest apply <preset> --only theme
pnpm dlx shadcn@latest view @ss-blocks/hero-section-01
pnpm dlx shadcn@latest search @shadcn -q button
```

`od shadcn view`, `od shadcn scaffold --cwd <new-project>`, and `od shadcn cli --cwd <new-project> -- ...` are the Open Design wrappers. Scaffold and cli refuse this repository.

## Admin template

The Studio admin dashboard is a Next.js app with route groups `(pages)` and `(blank)`, `src/views`, and `src/configs/navConfig.tsx`. It is not an HTML design template and must not replace the Open Design shell. After scaffolding it, replace the fake database using the documented real-API path.

## MCP

Three different servers share this topic. Do not treat them as one:

- Official shadcn registry MCP: search, view, list, and add commands.
- Shadcn Studio IDE MCP: `/cui`, `/rui`, `/iui` (Pro), and `/ftc` (needs Figma MCP and original frame names). Do not register it on the daemon.
- The daemon preset `npx @jpisnice/shadcn-ui-mcp-server` is a separate component browser. Leave it unchanged.
