import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function renderProbeScreenshotPath(artifactsRoot: string, projectId: string): string {
  if (!path.isAbsolute(artifactsRoot)) {
    throw new Error('artifacts root must be absolute');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(projectId) || projectId === '.' || projectId === '..') {
    throw new Error('invalid project id');
  }
  const name = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.png`;
  const outputPath = path.resolve(artifactsRoot, projectId, 'render-probe', name);
  const relative = path.relative(path.resolve(artifactsRoot), outputPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('screenshot path escapes artifacts root');
  }
  return outputPath;
}

export async function captureHtmlFileScreenshot(htmlPath: string, outputPath: string): Promise<void> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await page.screenshot({ path: outputPath, type: 'png', animations: 'disabled' });
  } finally {
    await browser.close();
  }
  const written = await stat(outputPath);
  if (written.size < 8) {
    throw new Error('screenshot capture wrote an empty file');
  }
}

export async function captureProjectRenderProbeScreenshot(input: {
  artifactsRoot: string;
  projectId: string;
  htmlPath: string;
  capture?: (htmlPath: string, outputPath: string) => Promise<void>;
}): Promise<string> {
  const outputPath = renderProbeScreenshotPath(input.artifactsRoot, input.projectId);
  const capture = input.capture ?? captureHtmlFileScreenshot;
  await capture(input.htmlPath, outputPath);
  return outputPath;
}
