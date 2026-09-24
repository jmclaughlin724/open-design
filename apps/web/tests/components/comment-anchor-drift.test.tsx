// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommentTargetOverlay } from '../../src/components/FileViewer';
import { applyCommentAnchorMoved, type PreviewCommentSnapshot } from '../../src/comments';
import {
  COMMENT_ANCHOR_BRIDGE_MARKER,
  buildCommentAnchorBridge,
  parseCommentAnchorMovedMessage,
  type CommentAnchorMovedMessage,
} from '@open-design/contracts/runtime/html-injection-points';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

afterEach(() => {
  cleanup();
});

type Rect = { x: number; y: number; width: number; height: number };

function snapshotAt(position: Rect): PreviewCommentSnapshot {
  return {
    filePath: 'index.html',
    elementId: 'hero',
    selector: '[data-od-id="hero"]',
    label: 'h1.hero',
    text: 'Title',
    position,
    htmlHint: '<h1 data-od-id="hero">',
  };
}

function installBridge(initial: Rect) {
  const dom = new JSDOM('<!doctype html><html><body><main data-od-id="hero">Title</main></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const parentPostMessage = vi.fn();
  Object.defineProperty(win, 'parent', {
    configurable: true,
    value: { postMessage: parentPostMessage },
  });
  const el = win.document.querySelector('[data-od-id="hero"]');
  if (!el) throw new Error('anchor element missing');
  const rect = { ...initial };
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.y,
      left: rect.x,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => ({}),
    }),
  });
  const script = buildCommentAnchorBridge();
  const code = script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
  new win.Function(code).call(win);
  return {
    win,
    parentPostMessage,
    setRect(next: Rect) {
      rect.x = next.x;
      rect.y = next.y;
      rect.width = next.width;
      rect.height = next.height;
    },
  };
}

async function waitForAnchor(
  parentPostMessage: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
): Promise<CommentAnchorMovedMessage> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const parsed = parentPostMessage.mock.calls
      .map((call) => parseCommentAnchorMovedMessage(call[0]))
      .filter((message): message is CommentAnchorMovedMessage => message !== null);
    const latest = parsed[parsed.length - 1];
    if (latest) return latest;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('anchorMoved was not posted');
}

describe('comment pin drift', () => {
  it('injects the anchor bridge only with the comment selection bridge', () => {
    const commenting = buildSrcdoc('<p data-od-id="hero">Title</p>', { commentBridge: true });
    const preview = buildSrcdoc('<p data-od-id="hero">Title</p>');

    expect(commenting).toContain(COMMENT_ANCHOR_BRIDGE_MARKER);
    expect(commenting).toContain('MutationObserver');
    expect(preview).not.toContain(COMMENT_ANCHOR_BRIDGE_MARKER);
  });

  it('moves the pin when a DOM mutation shifts the anchored element', async () => {
    const { win, parentPostMessage, setRect } = installBridge({ x: 12, y: 24, width: 80, height: 30 });
    const pinnedAt = await waitForAnchor(parentPostMessage);
    const targets = new Map([['hero', snapshotAt({ x: 1, y: 1, width: 2, height: 2 })]]);
    const pinned = applyCommentAnchorMoved(targets, pinnedAt);
    expect(pinned?.get('hero')?.position).toEqual({ x: 12, y: 24, width: 80, height: 30 });

    const { rerender } = render(
      <CommentTargetOverlay snapshot={pinned!.get('hero')!} scale={1} selected={false} />,
    );
    expect(screen.getByTestId('comment-target-overlay')).toHaveStyle({ left: '12px', top: '24px' });

    parentPostMessage.mockClear();
    setRect({ x: 90, y: 110, width: 140, height: 48 });
    const el = win.document.querySelector('[data-od-id="hero"]');
    const slot = win.document.createElement('section');
    win.document.body.appendChild(slot);
    slot.appendChild(el!);

    const moved = await waitForAnchor(parentPostMessage);
    const next = applyCommentAnchorMoved(pinned!, moved);
    expect(next?.get('hero')?.position).toEqual({ x: 90, y: 110, width: 140, height: 48 });

    rerender(<CommentTargetOverlay snapshot={next!.get('hero')!} scale={1} selected={false} />);
    expect(screen.getByTestId('comment-target-overlay')).toHaveStyle({ left: '90px', top: '110px' });
    expect(screen.getByTestId('comment-target-overlay')).not.toHaveStyle({ left: '12px' });
  });
});
