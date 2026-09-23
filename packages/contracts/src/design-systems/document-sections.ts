export const CANONICAL_SECTION_IDS = [
  'identity',
  'voice',
  'visual-foundations',
  'anti-patterns',
  'provenance',
  'caveats',
] as const;

export type DesignSystemDocumentSectionId = (typeof CANONICAL_SECTION_IDS)[number];

export type DesignSystemDocumentSection = {
  id: DesignSystemDocumentSectionId;
  title: string;
  body: string;
  startLine: number;
  endLine: number;
};

export type DesignSystemDocument = {
  sections: DesignSystemDocumentSection[];
};

export function isCanonicalSectionId(value: string): value is DesignSystemDocumentSectionId {
  return (CANONICAL_SECTION_IDS as readonly string[]).includes(value);
}

export function headingSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolveDesignSystemSectionId(heading: string): DesignSystemDocumentSectionId | null {
  const slug = headingSlug(heading);
  if (isCanonicalSectionId(slug)) return slug;
  const lower = heading.trim().toLowerCase();
  if (lower.includes('what this system is not') || lower.includes('anti-pattern') || lower.includes('anti pattern')) {
    return 'anti-patterns';
  }
  if (slug === 'sources' || lower.includes('provenance') || lower.includes('exported component')) {
    return 'provenance';
  }
  if (lower.includes('caveat') || lower.includes('substitution')) return 'caveats';
  if (slug === 'voice' || lower.includes('content fundamental')) return 'voice';
  if (slug === 'identity' || slug === 'brand' || lower.includes('visual theme')) return 'identity';
  if (lower.includes('visual foundation')) return 'visual-foundations';
  return null;
}

export function parseDesignSystemDocument(markdown: string): DesignSystemDocument {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const headings: Array<{ id: DesignSystemDocumentSectionId | null; title: string; line: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? '');
    if (!match?.[1]) continue;
    const title = match[1].replace(/\s+#+\s*$/, '').trim();
    headings.push({
      id: resolveDesignSystemSectionId(title),
      title,
      line: index + 1,
    });
  }

  const seen = new Set<DesignSystemDocumentSectionId>();
  const sections: DesignSystemDocumentSection[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (!heading?.id || seen.has(heading.id)) continue;
    seen.add(heading.id);
    const nextLine = headings[index + 1]?.line ?? lines.length + 1;
    const body = lines.slice(heading.line, nextLine - 1).join('\n').trim();
    sections.push({
      id: heading.id,
      title: heading.title,
      body,
      startLine: heading.line,
      endLine: Math.max(heading.line, nextLine - 1),
    });
  }
  return { sections };
}
