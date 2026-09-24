import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTemplateFromProjectFile,
  TemplateFromFileError,
} from '../src/templates/from-project-file.js';

const HTML = '<!doctype html><html><head><style>:root{--brand:#f06}</style></head><body><h1>Probe</h1></body></html>';

const tempDirs: string[] = [];

function tmpdir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'od-tpl-from-file-'));
  tempDirs.push(dir);
  return dir;
}

function bundledTemplate(root: string, id: string): string {
  const dir = path.join(root, id);
  mkdirSync(path.join(dir, 'examples'), { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: "${id}"\ndescription: |\n  Bundled parent template.\nod:\n  mode: utility\n---\n\n# Parent\n`,
    'utf8',
  );
  writeFileSync(path.join(dir, 'example.html'), '<html>parent</html>', 'utf8');
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createTemplateFromProjectFile', () => {
  it('creates a new user template with the HTML, generated SKILL.md, and token source', async () => {
    const bundled = tmpdir();
    const user = tmpdir();
    const result = await createTemplateFromProjectFile({
      request: { file: 'home.dc.html', name: 'My Brand Page' },
      html: HTML,
      designContext: { headings: [{ level: 1, text: 'Probe' }] },
      tokensCss: ':root { --brand: #f06; }',
      evidenceMd: '# evidence',
      templateRoots: [user, bundled],
      userTemplatesRoot: user,
    });

    expect(result.created).toBe('template');
    expect(result.templateId).toBe('my-brand-page');
    const dir = path.join(user, 'my-brand-page');
    expect(readFileSync(path.join(dir, 'example.html'), 'utf8')).toBe(HTML);
    const skill = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: "my-brand-page"');
    expect(skill).toContain('example_prompt');
    expect(readFileSync(path.join(dir, 'source', 'tokens.css'), 'utf8')).toContain('--brand');
    expect(readFileSync(path.join(dir, 'source', 'evidence.md'), 'utf8')).toBe('# evidence');
  });

  it('rejects a template id that already resolves in the roots', async () => {
    const bundled = tmpdir();
    bundledTemplate(bundled, 'existing-one');
    const user = tmpdir();
    await expect(
      createTemplateFromProjectFile({
        request: { file: 'home.dc.html', name: 'existing-one' },
        html: HTML,
        templateRoots: [user, bundled],
        userTemplatesRoot: user,
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_EXISTS', status: 409 });
  });

  it('requires a name when creating a template', async () => {
    await expect(
      createTemplateFromProjectFile({
        request: { file: 'home.dc.html' },
        html: HTML,
        templateRoots: [tmpdir()],
        userTemplatesRoot: tmpdir(),
      }),
    ).rejects.toBeInstanceOf(TemplateFromFileError);
  });

  it('adds a derived example under a bundled parent by shadowing it into the user root', async () => {
    const bundled = tmpdir();
    bundledTemplate(bundled, 'parent-tpl');
    const user = tmpdir();
    const result = await createTemplateFromProjectFile({
      request: { file: 'home.dc.html', intoTemplateId: 'parent-tpl' },
      html: HTML,
      tokensCss: ':root { --brand: #f06; }',
      templateRoots: [user, bundled],
      userTemplatesRoot: user,
    });

    expect(result.created).toBe('derived-example');
    expect(result.templateId).toBe('parent-tpl');
    expect(result.derivedExampleId).toBe('parent-tpl:example-home');
    expect(result.shadowedBundledParent).toBe(true);
    const shadow = path.join(user, 'parent-tpl');
    expect(readFileSync(path.join(shadow, 'SKILL.md'), 'utf8')).toContain('name: "parent-tpl"');
    expect(readFileSync(path.join(shadow, 'example.html'), 'utf8')).toBe('<html>parent</html>');
    expect(readFileSync(path.join(shadow, 'examples', 'example-home.html'), 'utf8')).toBe(HTML);
    expect(readFileSync(path.join(shadow, 'source', 'example-home.tokens.css'), 'utf8')).toContain('--brand');
  });

  it('rejects a derived example whose key already exists', async () => {
    const bundled = tmpdir();
    bundledTemplate(bundled, 'parent-tpl');
    const user = tmpdir();
    const input = {
      request: { file: 'home.dc.html', intoTemplateId: 'parent-tpl' },
      html: HTML,
      templateRoots: [user, bundled],
      userTemplatesRoot: user,
    };
    await createTemplateFromProjectFile(input);
    await expect(createTemplateFromProjectFile(input)).rejects.toMatchObject({
      code: 'EXAMPLE_EXISTS',
      status: 409,
    });
  });

  it('rejects an unknown parent template', async () => {
    await expect(
      createTemplateFromProjectFile({
        request: { file: 'home.dc.html', intoTemplateId: 'missing-parent' },
        html: HTML,
        templateRoots: [tmpdir()],
        userTemplatesRoot: tmpdir(),
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND', status: 404 });
  });

  it('rejects a colon-prefixed derived id as the parent', async () => {
    await expect(
      createTemplateFromProjectFile({
        request: { file: 'home.dc.html', intoTemplateId: 'parent:child' },
        html: HTML,
        templateRoots: [tmpdir()],
        userTemplatesRoot: tmpdir(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
  });
});
