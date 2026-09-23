import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_CONTEXT_RELATIVE_PATH } from '@open-design/contracts/api/design-context';
import { extractDesignContext, persistDesignContext } from '../src/design/design-context.js';

const FIXTURE_URL = new URL('./fixtures/claude-design-home.dc.html', import.meta.url);

function fixtureHtml(): string {
  return readFileSync(FIXTURE_URL, 'utf8');
}

describe('extractDesignContext', () => {
  it('reads headings, custom properties, and image paths from the canvas fixture', () => {
    const document = extractDesignContext(fixtureHtml(), { sourcePath: 'home.dc.html' });

    expect(document.schemaVersion).toBe(1);
    expect(document.sourcePath).toBe('home.dc.html');
    expect(document.headings).toEqual([]);
    expect(document.cssCustomProperties).toEqual([]);
    expect(document.imagePaths).toEqual(['assets/logo.png']);
  });

  it('collects headings, declared custom properties, and referenced images', () => {
    const document = extractDesignContext(`
      <html>
        <script>var trap = "<h1>hidden</h1>"; const css = "--secret: nope";</script>
        <style>
          :root { --bg: #fff; --accent: rgb(1, 2, 3); }
          .card { --radius: 8px; --bg: #111; }
          /* --ignored: 1px; */
          .hero { background: url("assets/hero.png?cache=1"); }
        </style>
        <body style="--gap: 1rem">
          <h1>Hello <span>there</span></h1>
          <h2> </h2>
          <h2>Section</h2>
          <img src="assets/logo.png?srcmap=1&amp;_omeo=host" />
          <img srcset="assets/a.png 1x, assets/b.png 2x" />
          <img src="data:image/png;base64,aaaa" />
          <script src="assets/app.js"></script>
        </body>
      </html>
    `);

    expect(document.headings).toEqual([
      { level: 1, text: 'Hello there' },
      { level: 2, text: 'Section' },
    ]);
    expect(document.cssCustomProperties).toEqual([
      { name: '--bg', value: '#111' },
      { name: '--accent', value: 'rgb(1, 2, 3)' },
      { name: '--radius', value: '8px' },
      { name: '--gap', value: '1rem' },
    ]);
    expect(document.imagePaths).toEqual([
      'assets/logo.png',
      'assets/a.png',
      'assets/b.png',
      'assets/hero.png',
    ]);
    expect(document.imagePaths).not.toContain('assets/app.js');
  });
});

describe('persistDesignContext', () => {
  it('writes context/design-context.json beside the project files', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'od-design-context-'));
    try {
      const document = await persistDesignContext({
        projectsRoot: tmp,
        projectId: 'proj-1',
        html: fixtureHtml(),
        sourcePath: 'home.dc.html',
      });
      const written = JSON.parse(readFileSync(
        path.join(tmp, 'proj-1', DESIGN_CONTEXT_RELATIVE_PATH),
        'utf8',
      ));
      expect(written).toEqual(document);
      expect(written.imagePaths).toEqual(['assets/logo.png']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
