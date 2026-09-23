import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOKEN_SCHEMA } from '@open-design/contracts/design-systems/token-schema';
import {
  CLAUDE_DESIGN_SOURCE_KIND,
  adaptClaudeDesignSource,
} from '../src/design/claude-design-source.js';

const FIXTURE_URL = new URL('./fixtures/claude-design-home.dc.html', import.meta.url);
const GENERATED_AT = new Date('2026-05-18T09:00:00.000Z');

function fixtureHtml(): string {
  return readFileSync(FIXTURE_URL, 'utf8');
}

describe('adaptClaudeDesignSource', () => {
  it('grades the home canvas fixture as weak evidence and names the source', () => {
    const adapted = adaptClaudeDesignSource({
      html: fixtureHtml(),
      sourcePath: 'home.dc.html',
      generatedAt: GENERATED_AT,
    });

    expect(adapted.sourceKind).toBe(CLAUDE_DESIGN_SOURCE_KIND);
    expect(adapted.sourceKind).toBe('claude-design-import');
    expect(adapted.sourcePath).toBe('home.dc.html');
    expect(adapted.properties).toEqual([]);
    expect(adapted.bindings.map((binding) => binding.name)).toEqual(TOKEN_SCHEMA.map((spec) => spec.name));
    expect(adapted.bindings.map((binding) => binding.layer)).toEqual(TOKEN_SCHEMA.map((spec) => spec.layer));
    expect(adapted.report.contract).toBe('TOKEN_SCHEMA');
    expect(adapted.report.summary.totalTokens).toBe(TOKEN_SCHEMA.length);
    expect(adapted.report.summary.declaredTokens).toBe(TOKEN_SCHEMA.length);
    expect(adapted.report.summary.sourceBackedTokens).toBe(0);
    expect(adapted.report.summary.sourceBackedA1).toBe(0);
    expect(adapted.report.summary.grade).toBe('needs-rebuild');
    expect(adapted.report.selfCheck.ok).toBe(true);
    expect(adapted.report.generatedAt).toBe(GENERATED_AT.toISOString());
    expect(adapted.tokensCss).toContain('--bg:');
    expect(adapted.tokensCss).not.toContain('--secret');
    expect(adapted.evidenceMd).toContain('`claude-design-import`');
    expect(adapted.evidenceMd).toContain('`home.dc.html`');
    expect(adapted.evidenceMd).toContain('No CSS custom properties detected');
  });

  it('maps style-block and inline custom properties onto the schema', () => {
    const adapted = adaptClaudeDesignSource({
      html: `
        <html>
          <script>const trap = "--secret: #fff; --bg: #000";</script>
          <style>
            :root { --bg: #111111; --accent: var(--not-schema); }
            .card { --color-primary: #ff3366; --radius-card: 12px; --mystery: 4px; }
            /* --ignored: 1px; */
          </style>
          <body style="--font-body: Inter, sans-serif; --bg: #222222">
            <h1>Home</h1>
          </body>
        </html>
      `,
      sourcePath: 'home.dc.html',
      generatedAt: GENERATED_AT,
    });

    expect(adapted.properties).toEqual([
      { name: '--bg', value: '#222222' },
      { name: '--accent', value: 'var(--not-schema)' },
      { name: '--color-primary', value: '#ff3366' },
      { name: '--radius-card', value: '12px' },
      { name: '--mystery', value: '4px' },
      { name: '--font-body', value: 'Inter, sans-serif' },
    ]);
    expect(adapted.bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: '--bg',
        layer: 'A1-identity',
        value: '#222222',
        confidence: 'high',
        sources: ['home.dc.html'],
      }),
      expect.objectContaining({
        name: '--accent',
        layer: 'A1-identity',
        value: '#ff3366',
        confidence: 'medium',
        sourceName: '--color-primary',
      }),
      expect.objectContaining({
        name: '--radius-md',
        value: '12px',
        confidence: 'medium',
        sourceName: '--radius-card',
      }),
      expect.objectContaining({
        name: '--font-body',
        value: 'Inter, sans-serif',
        confidence: 'high',
      }),
      expect.objectContaining({
        name: '--fg',
        confidence: 'low',
      }),
      expect.objectContaining({
        name: '--surface-warm',
        confidence: 'alias',
        value: 'var(--surface)',
      }),
    ]));
    expect(adapted.tokensCss).not.toContain('--mystery');
    expect(adapted.tokensCss).not.toContain('--secret');
    expect(adapted.tokensCss).not.toContain('var(--not-schema)');
    expect(adapted.tokensCss).not.toContain('--color-primary');
    expect(adapted.report.selfCheck.ok).toBe(true);
    expect(adapted.report.summary.declaredTokens).toBe(TOKEN_SCHEMA.length);
    expect(adapted.report.summary.sourceBackedTokens).toBeGreaterThan(0);
    expect(adapted.evidenceMd).toContain('Source kind: `claude-design-import`');
  });

  it('drops an unusable exact value to the importer default', () => {
    const adapted = adaptClaudeDesignSource({
      properties: [{ name: '--fg', value: 'var(--nope)' }],
      sourcePath: 'inline.html',
      generatedAt: GENERATED_AT,
    });
    const fg = adapted.bindings.find((binding) => binding.name === '--fg');

    expect(fg).toMatchObject({
      confidence: 'low',
      value: '#111827',
      sources: [],
    });
    expect(adapted.tokensCss).not.toContain('var(--nope)');
  });

  it('prefers an extracted property list over html', () => {
    const adapted = adaptClaudeDesignSource({
      html: '<style>:root { --bg: #ffffff; }</style>',
      properties: [{ name: '--bg', value: '#010101' }],
      generatedAt: GENERATED_AT,
    });
    const bg = adapted.bindings.find((binding) => binding.name === '--bg');

    expect(adapted.sourcePath).toBeNull();
    expect(adapted.evidenceMd).toContain('Source path: not declared');
    expect(bg).toMatchObject({ value: '#010101', confidence: 'high' });
  });
});
