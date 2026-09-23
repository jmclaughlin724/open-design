import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { absorbedKindPreviewTransport } from '@open-design/contracts/api/absorbed-files';
import {
  CLAUDE_DESIGN_IMPORT_LIMITS,
  chooseAbsorbedEntryFile,
  classifyAbsorbedFile,
  discoverVendoredSandboxRuntimePaths,
  importClaudeDesignFiles,
  rewriteVendoredSandboxRuntimeUrls,
  stripClaudeDesignHostRemnants,
} from '../src/design/claude-design-import.js';

const FIXTURE_URL = new URL('./fixtures/claude-design-home.dc.html', import.meta.url);
const RUNTIME_PATHS = {
  tailwind: '/vendor/tailwind.js',
  babel: '/vendor/babel.min.js',
  react: '/vendor/react.development.js',
  reactDom: '/vendor/react-dom.development.js',
};

function fixtureHtml(): string {
  return readFileSync(FIXTURE_URL, 'utf8');
}

describe('classifyAbsorbedFile', () => {
  it('classifies canvas, deck, prototype, and generic HTML', () => {
    expect(classifyAbsorbedFile('home.dc.html', '<html></html>')).toBe('design-canvas');
    expect(classifyAbsorbedFile('index.html', '<script src="design-canvas.jsx"></script>')).toBe('design-canvas');
    expect(classifyAbsorbedFile('pitch.html', '<html></html>')).toBe('deck');
    expect(classifyAbsorbedFile('slides/index.html', '<html></html>')).toBe('deck');
    expect(classifyAbsorbedFile('page.html', '<deck-stage><section class="slide"></section></deck-stage>')).toBe('deck');
    expect(classifyAbsorbedFile('app.html', '<script type="text/babel" src="app.jsx"></script>')).toBe('prototype');
    expect(classifyAbsorbedFile('prototype/index.html', '<html></html>')).toBe('prototype');
    expect(classifyAbsorbedFile('index.html', '<html><body>hello</body></html>')).toBe('html');
    expect(classifyAbsorbedFile('assets/logo.png')).toBeNull();
  });

  it('prefers a detected canvas over a bare index.html', () => {
    expect(chooseAbsorbedEntryFile([
      { path: 'index.html', source: '<html>index</html>' },
      { path: 'frames/home.dc.html', source: '<html></html>' },
    ])).toBe('frames/home.dc.html');
  });

  it('keeps root index.html when every HTML file is generic', () => {
    expect(chooseAbsorbedEntryFile([
      { path: 'page.html', source: '<html></html>' },
      { path: 'index.html', source: '<html></html>' },
    ])).toBe('index.html');
  });

  it('maps kind to preview transport without probing HTML', () => {
    expect(absorbedKindPreviewTransport('design-canvas')).toBe('srcdoc');
    expect(absorbedKindPreviewTransport('deck')).toBe('srcdoc');
    expect(absorbedKindPreviewTransport('prototype')).toBe('url');
    expect(absorbedKindPreviewTransport('html')).toBe('url');
  });
});

describe('Claude Design HTML normalization', () => {
  it('does not invent vendored runtime URLs when the files are absent', () => {
    expect(discoverVendoredSandboxRuntimePaths()).toEqual({});
  });

  it('strips host remnants and rewrites CDN script URLs when paths are supplied', () => {
    const stripped = stripClaudeDesignHostRemnants(fixtureHtml());
    expect(stripped).not.toContain('__OM_EVT__');
    expect(stripped).not.toContain('_omeo');
    expect(stripped).not.toContain('srcmap');
    expect(stripped).toContain('assets/app.js');
    expect(stripped).toContain('assets/logo.png');

    const rewritten = rewriteVendoredSandboxRuntimeUrls(stripped, RUNTIME_PATHS);
    expect(rewritten).toContain('src="/vendor/tailwind.js"');
    expect(rewritten).toContain('src="/vendor/babel.min.js"');
    expect(rewritten).toContain('src="/vendor/react.development.js"');
    expect(rewritten).toContain('src="/vendor/react-dom.development.js"');
    expect(rewritten).not.toContain('cdn.tailwindcss.com');
    expect(rewritten).not.toContain('unpkg.com');
  });
});

describe('importClaudeDesignFiles', () => {
  it('ingests the fixture with zip path limits and prefers the canvas entry', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-loose-'));
    const projectDir = path.join(tmp, 'proj');
    try {
      const result = await importClaudeDesignFiles([
        { path: 'index.html', body: Buffer.from('<html>bare index</html>') },
        { path: 'home.dc.html', body: Buffer.from(fixtureHtml()) },
        { path: 'assets/logo.png', body: Buffer.from('png') },
      ], projectDir, { runtimePaths: RUNTIME_PATHS });

      expect(result.entryFile).toBe('home.dc.html');
      expect(result.entryKind).toBe('design-canvas');
      expect(result.previewTransport).toBe('srcdoc');
      expect(result.kinds['index.html']).toBe('html');
      expect(result.files).toContain('assets/logo.png');

      const written = readFileSync(path.join(projectDir, 'home.dc.html'), 'utf8');
      expect(written).not.toContain('__OM_EVT__');
      expect(written).not.toContain('_omeo');
      expect(written).not.toContain('srcmap');
      expect(written).toContain('src="/vendor/tailwind.js"');
      expect(written).toContain('src="/vendor/babel.min.js"');
      expect(written).toContain('src="/vendor/react.development.js"');
      expect(written).toContain('src="/vendor/react-dom.development.js"');
      expect(written).toContain('src="assets/app.js"');
      expect(written).toContain('src="assets/logo.png"');
      expect(written).not.toContain('cdn.tailwindcss.com');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('absolutizes nested assets/ references against the project root', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-assets-'));
    const projectDir = path.join(tmp, 'proj');
    try {
      await importClaudeDesignFiles([
        {
          path: 'pages/home.dc.html',
          body: Buffer.from('<html><img src="assets/logo.png"><img src="./assets/mark.png"></html>'),
        },
      ], projectDir);
      const written = readFileSync(path.join(projectDir, 'pages/home.dc.html'), 'utf8');
      expect(written).toContain('src="../assets/logo.png"');
      expect(written).toContain('src="../assets/mark.png"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects traversal and oversize files with the zip limits', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-limits-'));
    const projectDir = path.join(tmp, 'proj');
    try {
      await expect(importClaudeDesignFiles([
        { path: '../secret.html', body: Buffer.from('<html></html>') },
      ], projectDir)).rejects.toThrow(/invalid file name|absolute zip paths/);

      await expect(importClaudeDesignFiles([
        { path: '/etc/passwd.html', body: Buffer.from('<html></html>') },
      ], projectDir)).rejects.toThrow(/absolute zip paths/);

      await expect(importClaudeDesignFiles([
        {
          path: 'index.html',
          body: Buffer.alloc(CLAUDE_DESIGN_IMPORT_LIMITS.maxFileBytes + 1),
        },
      ], projectDir)).rejects.toThrow(/too large/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
