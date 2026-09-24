import { describe, expect, it } from 'vitest';
import {
  ART_DECO_THEME_URL,
  classifyShadcnRegistryItem,
  NOVA_INIT_URL,
  resolveStudioNamespace,
  STUDIO_NAMESPACE_TEMPLATES,
} from '../../src/design-systems/shadcn-registry.js';

describe('shadcn registry classification', () => {
  it('treats the Studio components.json URL shape as an init preset', () => {
    expect(classifyShadcnRegistryItem({
      name: 'components-json',
      type: 'registry:base',
      config: { style: 'base-nova' },
    })).toBe('init-preset');
    expect(NOVA_INIT_URL).toContain('style=nova');
  });

  it('treats a token-bearing registry:base item as a theme', () => {
    expect(classifyShadcnRegistryItem({
      name: 'art-deco',
      type: 'registry:base',
      cssVars: { light: { primary: 'oklch(0.77 0.14 91.05)' } },
    })).toBe('theme');
    expect(ART_DECO_THEME_URL).toBe('https://shadcnstudio.com/r/themes/art-deco.json');
  });

  it('resolves every documented Studio namespace', () => {
    expect(Object.keys(STUDIO_NAMESPACE_TEMPLATES)).toEqual([
      '@shadcn-studio',
      '@ss-components',
      '@ss-blocks',
      '@ss-pages',
      '@ss-illustrations',
      '@ss-themes',
      '@ss-fonts',
    ]);
    expect(resolveStudioNamespace('@ss-blocks/hero-section-01')).toBe(
      'https://shadcnstudio.com/r/blocks/base-nova/hero-section-01.json',
    );
    expect(resolveStudioNamespace('@ss-illustrations/empty')).toBe(
      'https://shadcnstudio.com/r/illustrations/empty.json',
    );
    expect(resolveStudioNamespace('@unknown/button')).toBeNull();
  });
});
