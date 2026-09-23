import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readAppConfig, writeAppConfig } from '../src/app-config.js';
import {
  designSystemIdAfterValidation,
  selectCreateDesignSystemId,
} from '../src/default-design-system.js';

describe('workspace default design system', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('round-trips defaultDesignSystemId through app config', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-default-ds-'));
    dirs.push(dataDir);
    await writeAppConfig(dataDir, { defaultDesignSystemId: 'editorial' });
    expect((await readAppConfig(dataDir)).defaultDesignSystemId).toBe('editorial');

    await writeAppConfig(dataDir, { defaultDesignSystemId: null });
    expect((await readAppConfig(dataDir)).defaultDesignSystemId).toBeNull();
  });

  it('drops a non-string defaultDesignSystemId', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-default-ds-'));
    dirs.push(dataDir);
    await writeAppConfig(dataDir, { defaultDesignSystemId: 12 as unknown as string });
    expect(await readAppConfig(dataDir)).not.toHaveProperty('defaultDesignSystemId');
  });

  it('inherits the workspace default when create omits designSystemId', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-default-ds-'));
    dirs.push(dataDir);
    await writeAppConfig(dataDir, { defaultDesignSystemId: 'editorial' });
    const config = await readAppConfig(dataDir);
    const selection = selectCreateDesignSystemId({
      body: { name: 'New project' },
      workspaceDefaultId: config.defaultDesignSystemId,
    });
    const resolved = designSystemIdAfterValidation({
      selection,
      validationOk: true,
      validatedId: 'editorial',
    });
    expect(selection).toEqual({ explicit: false, id: 'editorial', invalid: false });
    expect(resolved).toEqual({ ok: true, id: 'editorial' });
  });

  it('treats an explicit null as a per-project override', () => {
    const selection = selectCreateDesignSystemId({
      body: { designSystemId: null },
      workspaceDefaultId: 'editorial',
    });
    expect(selection).toEqual({ explicit: true, id: null, invalid: false });
    expect(designSystemIdAfterValidation({
      selection,
      validationOk: true,
      validatedId: null,
    })).toEqual({ ok: true, id: null });
  });

  it('does not block creation when the inherited default fails catalog validation', () => {
    const selection = selectCreateDesignSystemId({
      body: {},
      workspaceDefaultId: 'missing-system',
    });
    expect(designSystemIdAfterValidation({
      selection,
      validationOk: false,
      validatedId: null,
    })).toEqual({ ok: true, id: null });
  });

  it('rejects an explicit pick that fails catalog validation', () => {
    const selection = selectCreateDesignSystemId({
      body: { designSystemId: 'missing-system' },
      workspaceDefaultId: 'editorial',
    });
    expect(designSystemIdAfterValidation({
      selection,
      validationOk: false,
      validatedId: null,
    })).toEqual({ ok: false });
  });
});
