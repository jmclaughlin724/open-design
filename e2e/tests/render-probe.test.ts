// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite } from '@/vitest/suite';

type ProjectResponse = {
  project: { id: string };
};

type ProbeResponse = {
  ok: boolean;
  value: string | boolean | null;
  matched: boolean;
  screenshot: string | null;
  screenshotRequested: boolean;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('render probe smoke', () => {
  test('a running daemon evaluates a fixture heading and writes a PNG', async () => {
    const suite = await createSmokeSuite('render-probe');
    await suite.with.toolsDev(async ({ webUrl }) => {
      const project = await requestJson<ProjectResponse>(webUrl, '/api/projects', {
        body: {
          id: randomUUID(),
          name: 'Render probe smoke',
          metadata: { kind: 'prototype' },
        },
        method: 'POST',
      });
      const projectId = project.project.id;
      await requestJson(webUrl, `/api/projects/${encodeURIComponent(projectId)}/files`, {
        body: {
          content: '<!doctype html><html><body><h1 id="probe-heading">Probe ready</h1></body></html>',
          name: 'index.html',
        },
        method: 'POST',
      });

      const probed = await requestJson<ProbeResponse>(
        webUrl,
        `/api/projects/${encodeURIComponent(projectId)}/render-probe`,
        {
          body: {
            expression: 'heading("Probe ready")',
            file: 'index.html',
            screenshot: true,
          },
          method: 'POST',
        },
      );
      expect(probed.ok).toBe(true);
      expect(probed.value).toBe(true);
      expect(probed.matched).toBe(true);
      expect(probed.screenshotRequested).toBe(true);
      expect(probed.screenshot).toEqual(expect.any(String));
      const png = await readFile(probed.screenshot ?? '');
      expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
      await suite.report.json('summary.json', {
        projectId,
        screenshot: probed.screenshot,
        value: probed.value,
      });
    });
  }, 180_000);
});
