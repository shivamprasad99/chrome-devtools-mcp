/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {zod} from '../third_party/index.js';
import type {
  CDPSession,
  ElementHandle,
  Frame,
  Page,
} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const OVERLAY_ID = '__trustpulse_helper_highlight';
const LABEL_ID = '__trustpulse_helper_highlight_label';
const HIGHLIGHT_COLOR = '#ff0000';
const HIGHLIGHT_DEFAULT_STROKE_WIDTH = 4;
const HIGHLIGHT_DEFAULT_PADDING = 2;
const HIGHLIGHT_DEFAULT_MIN_VISIBLE_RATIO = 0.6;
const DEFAULT_RECORDING_FPS = 15;
const DEFAULT_RECORDING_QUALITY = 80;
const MAX_FFMPEG_STDERR_CHARS = 8_000;
const AUTO_STOP_RECORDING_MS = 300_000;
const STOP_STEP_TIMEOUT_MS = 8_000;
const STOP_GRACEFUL_RECOVERY_TIMEOUT_MS = 10_000;
const STALE_RECORDING_AFTER_MS = AUTO_STOP_RECORDING_MS + 20_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface HighlightBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HighlightDiagnostics {
  ok: boolean;
  uid: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  interactionPoint: {
    x: number;
    y: number;
  };
  visibleRatio: number;
  intersectsViewport: boolean;
  centerHit: boolean;
  styleVisible: boolean;
  pageUrl: string;
  pageTitle: string;
  viewport: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
    scrollX: number;
    scrollY: number;
  };
  elementPageUrl: string;
  elementPageTitle: string;
}

interface StopRecordingPayload {
  ok: boolean;
  outputPath: string;
  pageUrl: string;
  targetFps: number;
  frameCount: number;
  durationMs: number;
  autoStopped: boolean;
  stopReason: string;
}

interface RecordingSession {
  page: Page;
  client: CDPSession;
  ffmpeg: ChildProcessWithoutNullStreams;
  frameHandler: (frameEvent: {data: string; sessionId: number}) => void;
  ffmpegErrorTextRef: () => string;
  outputPath: string;
  pageUrl: string;
  startTimeMs: number;
  targetFps: number;
  autoStopTimer: TimeoutHandle | null;
  stopPromise: Promise<StopRecordingPayload> | null;
  getFrameCount: () => number;
  getWriteChain: () => Promise<void>;
  getWriteFailure: () => Error | null;
}

let activeRecording: RecordingSession | null = null;

function getDownloadsDirectory() {
  const candidates = [];
  const xdgDownloadDir = process.env.XDG_DOWNLOAD_DIR;
  if (xdgDownloadDir) {
    candidates.push(xdgDownloadDir);
  }
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    candidates.push(path.join(process.env.USERPROFILE, 'Downloads'));
  }
  candidates.push(path.join(os.homedir(), 'Downloads'));

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const resolved = path.resolve(candidate);
    try {
      fs.mkdirSync(resolved, {recursive: true});
      return resolved;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error('Unable to resolve a writable Downloads directory.');
}

function timestampForFilename() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

function resolveRecordingOutputPath(fileName?: string) {
  const downloadsDir = getDownloadsDirectory();
  const raw = (fileName ?? '').trim();
  const parsed = path.parse(
    raw || `browser-recording-${timestampForFilename()}.mp4`,
  );
  const fallbackStem = `browser-recording-${timestampForFilename()}`;
  const safeStem =
    sanitizeFilename(parsed.name || fallbackStem) || 'browser-recording';
  const ext = parsed.ext ? parsed.ext.toLowerCase() : '.mp4';
  const safeExt = ext === '.mp4' ? ext : '.mp4';
  return path.join(downloadsDir, `${safeStem}${safeExt}`);
}

async function ensureFfmpegAvailable(): Promise<void> {
  await new Promise((resolve, reject) => {
    const probe = spawn('ffmpeg', ['-version'], {stdio: 'ignore'});
    probe.once('error', () => {
      reject(new Error('`ffmpeg` is required but was not found on PATH.'));
    });
    probe.once('close', code => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(
        new Error(
          '`ffmpeg -version` failed; install or fix ffmpeg before recording.',
        ),
      );
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function writeToStream(stream: NodeJS.WritableStream, chunk: Uint8Array) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off('error', onError);
      stream.off('drain', onDrain);
    };

    stream.once('error', onError);
    if (stream.write(chunk)) {
      cleanup();
      resolve();
      return;
    }
    stream.once('drain', onDrain);
  });
}

function endWritableStream(stream: NodeJS.WritableStream) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off('error', onError);
      stream.off('finish', onFinish);
    };

    stream.once('error', onError);
    stream.once('finish', onFinish);
    stream.end();
  });
}

function waitForProcessExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
) {
  return new Promise<{code: number | null; signal: NodeJS.Signals | null}>(
    (resolve, reject) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve({code: proc.exitCode, signal: proc.signalCode});
        return;
      }

      const timeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore kill failures.
        }
        reject(
          new Error(`Timed out waiting for process exit after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      proc.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({code, signal});
      });
    },
  );
}

function clearAutoStopTimer(session: RecordingSession | null) {
  if (session?.autoStopTimer) {
    clearTimeout(session.autoStopTimer);
    session.autoStopTimer = null;
  }
}

function isRecordingSessionLikelyStale(session: RecordingSession | null) {
  if (!session) {
    return false;
  }
  if (session.stopPromise) {
    return true;
  }
  if (session.ffmpeg.exitCode !== null || session.ffmpeg.signalCode !== null) {
    return true;
  }
  if (session.ffmpeg.stdin.destroyed) {
    return true;
  }
  const ageMs = Math.max(0, Date.now() - (session.startTimeMs ?? Date.now()));
  return ageMs > STALE_RECORDING_AFTER_MS;
}

async function detachClient(session: RecordingSession) {
  try {
    await withTimeout(session.client.detach(), 1_500, 'CDP session detach');
  } catch {
    // Ignore detach failures during cleanup.
  }
}

async function clearHighlightOnPage(page: Page) {
  return await page.evaluate(
    ({overlayId, labelId}) => {
      let removed = 0;
      for (const id of [overlayId, labelId]) {
        const node = document.getElementById(id);
        if (node) {
          node.remove();
          removed += 1;
        }
      }
      return {
        ok: true,
        removed,
        pageUrl: location.href,
        pageTitle: document.title,
      };
    },
    {overlayId: OVERLAY_ID, labelId: LABEL_ID},
  );
}

async function hardCleanupRecordingSession(session: RecordingSession | null) {
  if (!session) {
    return;
  }

  clearAutoStopTimer(session);
  if (activeRecording === session) {
    activeRecording = null;
  }

  try {
    await withTimeout(
      session.client.send('Page.stopScreencast'),
      1_500,
      'CDP stopScreencast (hard cleanup)',
    );
  } catch {
    // Ignore stop failures during hard cleanup.
  }
  if (typeof session.client.off === 'function') {
    try {
      session.client.off('Page.screencastFrame', session.frameHandler);
    } catch {
      // Ignore listener removal errors.
    }
  }
  try {
    session.ffmpeg.stdin.destroy();
  } catch {
    // Ignore stdin destroy failures.
  }
  try {
    session.ffmpeg.kill('SIGKILL');
  } catch {
    // Ignore kill failures during hard cleanup.
  }
  await detachClient(session);
}

async function recoverActiveRecordingForStart() {
  if (!activeRecording) {
    return;
  }

  const session = activeRecording;
  if (!isRecordingSessionLikelyStale(session)) {
    throw new Error(
      `A recording is already active. Stop it before starting a new one. Active output: ${session.outputPath}`,
    );
  }

  try {
    await withTimeout(
      stopScreenRecordingSession(session, 'stale_recovery'),
      STOP_GRACEFUL_RECOVERY_TIMEOUT_MS,
      'stale recording recovery',
    );
  } catch {
    await hardCleanupRecordingSession(session);
  }
}

function buildScreencastOptions(input: {
  fps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}) {
  const fps = input.fps ?? DEFAULT_RECORDING_FPS;
  const quality = input.quality ?? DEFAULT_RECORDING_QUALITY;
  const normalizedFps = Math.max(1, Math.min(60, fps));
  const everyNthFrame = Math.max(1, Math.round(60 / normalizedFps));
  const options: {
    format: 'jpeg';
    quality: number;
    everyNthFrame: number;
    maxWidth?: number;
    maxHeight?: number;
  } = {
    format: 'jpeg',
    quality: Math.max(1, Math.min(100, quality)),
    everyNthFrame,
  };
  if (input.maxWidth) {
    options.maxWidth = input.maxWidth;
  }
  if (input.maxHeight) {
    options.maxHeight = input.maxHeight;
  }
  return {options, targetFps: normalizedFps};
}

async function scrollContainingFramesIntoView(frame: Frame): Promise<void> {
  const framesToScroll: Frame[] = [];
  let currentFrame: Frame | null = frame;
  while (currentFrame && currentFrame.parentFrame()) {
    framesToScroll.push(currentFrame);
    currentFrame = currentFrame.parentFrame();
  }

  for (const nestedFrame of framesToScroll.reverse()) {
    const frameElement = await nestedFrame.frameElement();
    if (!frameElement) {
      continue;
    }
    try {
      await frameElement.evaluate(element => {
        element.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'auto',
        });
      });
    } finally {
      await frameElement.dispose();
    }
  }
}

async function prepareTargetForHighlight(handle: ElementHandle<Element>) {
  return await handle.evaluate((target, minVisibleRatio) => {
    function getScrollableAncestors(element: Element) {
      const ancestors: Element[] = [];
      let node = element.parentElement;
      while (node) {
        const style = getComputedStyle(node);
        const overflow = `${style.overflow}${style.overflowX}${style.overflowY}`;
        const scrollable =
          /(auto|scroll|overlay)/.test(overflow) &&
          (node.scrollHeight > node.clientHeight + 1 ||
            node.scrollWidth > node.clientWidth + 1);
        if (scrollable) {
          ancestors.push(node);
        }
        node = node.parentElement;
      }
      return ancestors.reverse();
    }

    function centerVerticallyWithinScrollParent(
      element: Element,
      parent: Element,
    ) {
      const elementRect = element.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const targetTop =
        parent.scrollTop +
        (elementRect.top - parentRect.top) -
        (parent.clientHeight - elementRect.height) / 2;
      parent.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'auto',
      });
    }

    function visibleRatioForRect(rect: DOMRect) {
      const width = Math.max(
        0,
        Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
      );
      const height = Math.max(
        0,
        Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
      );
      const visibleArea = width * height;
      const totalArea = Math.max(1, rect.width * rect.height);
      return visibleArea / totalArea;
    }

    function centerHitPasses(element: Element, rect: DOMRect) {
      const cx = Math.min(
        window.innerWidth - 1,
        Math.max(0, rect.left + rect.width / 2),
      );
      const cy = Math.min(
        window.innerHeight - 1,
        Math.max(0, rect.top + rect.height / 2),
      );
      const hit = document.elementFromPoint(cx, cy);
      return {
        point: {x: cx, y: cy},
        centerHit: !!hit && (hit === element || element.contains(hit)),
      };
    }

    function isStyleVisible(element: Element) {
      const computed = getComputedStyle(element);
      return (
        computed.display !== 'none' &&
        computed.visibility !== 'hidden' &&
        computed.visibility !== 'collapse' &&
        Number.parseFloat(computed.opacity || '1') > 0
      );
    }

    const ancestors = getScrollableAncestors(target);
    for (const ancestor of ancestors) {
      centerVerticallyWithinScrollParent(target, ancestor);
    }

    target.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'auto',
    });

    const before = target.getBoundingClientRect();
    const absoluteTop =
      window.scrollY + before.top - (window.innerHeight - before.height) / 2;
    window.scrollTo({
      top: Math.max(0, absoluteTop),
      behavior: 'auto',
    });

    const rect = target.getBoundingClientRect();
    const visibleRatio = visibleRatioForRect(rect);
    const hitCheck = centerHitPasses(target, rect);
    const styleVisible = isStyleVisible(target);
    const intersectsViewport =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;

    return {
      ok:
        styleVisible &&
        intersectsViewport &&
        visibleRatio >= minVisibleRatio &&
        hitCheck.centerHit,
      visibleRatio,
      intersectsViewport,
      centerHit: hitCheck.centerHit,
      styleVisible,
      interactionPoint: hitCheck.point,
      elementPageUrl: location.href,
      elementPageTitle: document.title,
    };
  }, HIGHLIGHT_DEFAULT_MIN_VISIBLE_RATIO);
}

async function drawOverlayOnPage(page: Page, box: HighlightBox) {
  return await page.evaluate(
    ({overlayId, labelId, highlightColor, strokeWidth, padding, targetBox}) => {
      function clearExistingOverlay() {
        document.getElementById(overlayId)?.remove();
        document.getElementById(labelId)?.remove();
      }

      function installAutoCleanupHooks() {
        const hookKey = '__trustpulseHelperHighlightHooksInstalled';
        const existingCleanup = (
          window as typeof window & {
            __trustpulseHelperHighlightCleanup?: () => void;
            [hookKey]?: boolean;
          }
        ).__trustpulseHelperHighlightCleanup;
        if ((window as typeof window & {[hookKey]?: boolean})[hookKey]) {
          existingCleanup?.();
          return;
        }
        const cleanup = () => {
          clearExistingOverlay();
        };
        window.addEventListener('pagehide', cleanup, true);
        window.addEventListener('beforeunload', cleanup, true);
        window.addEventListener('pageshow', cleanup, true);
        window.addEventListener('popstate', cleanup, true);
        (
          window as typeof window & {
            __trustpulseHelperHighlightCleanup?: () => void;
            [hookKey]?: boolean;
          }
        ).__trustpulseHelperHighlightCleanup = cleanup;
        (window as typeof window & {[hookKey]?: boolean})[hookKey] = true;
      }

      clearExistingOverlay();
      installAutoCleanupHooks();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.setAttribute('data-trustpulse-helper', 'overlay');
      Object.assign(overlay.style, {
        position: 'fixed',
        left: `${Math.max(0, targetBox.x - padding)}px`,
        top: `${Math.max(0, targetBox.y - padding)}px`,
        width: `${Math.max(0, targetBox.width + padding * 2)}px`,
        height: `${Math.max(0, targetBox.height + padding * 2)}px`,
        border: `${strokeWidth}px solid ${highlightColor}`,
        borderRadius: '10px',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        zIndex: '2147483647',
      });
      (document.body || document.documentElement).appendChild(overlay);
    },
    {
      overlayId: OVERLAY_ID,
      labelId: LABEL_ID,
      highlightColor: HIGHLIGHT_COLOR,
      strokeWidth: HIGHLIGHT_DEFAULT_STROKE_WIDTH,
      padding: HIGHLIGHT_DEFAULT_PADDING,
      targetBox: box,
    },
  );
}

async function focusAndHighlightByUid(
  page: Page,
  handle: ElementHandle<Element>,
  uid: string,
): Promise<HighlightDiagnostics> {
  await scrollContainingFramesIntoView(handle.frame);
  const inspection = await prepareTargetForHighlight(handle);
  await scrollContainingFramesIntoView(handle.frame);
  const box = await handle.boundingBox();
  if (!box) {
    throw new Error(
      `Element with uid ${uid} is no longer visible in layout. Take a fresh snapshot and retry.`,
    );
  }

  await drawOverlayOnPage(page, box);

  const payload = await page.evaluate(
    ({targetBox, uid, minVisibleRatio}) => {
      function visibleRatioForBox(box: HighlightBox) {
        const width = Math.max(
          0,
          Math.min(box.x + box.width, window.innerWidth) - Math.max(box.x, 0),
        );
        const height = Math.max(
          0,
          Math.min(box.y + box.height, window.innerHeight) - Math.max(box.y, 0),
        );
        const visibleArea = width * height;
        const totalArea = Math.max(1, box.width * box.height);
        return visibleArea / totalArea;
      }

      const visibleRatio = visibleRatioForBox(targetBox);
      const intersectsViewport =
        targetBox.width > 0 &&
        targetBox.height > 0 &&
        targetBox.x + targetBox.width > 0 &&
        targetBox.y + targetBox.height > 0 &&
        targetBox.x < window.innerWidth &&
        targetBox.y < window.innerHeight;
      const interactionPoint = {
        x: Math.min(
          window.innerWidth - 1,
          Math.max(0, targetBox.x + targetBox.width / 2),
        ),
        y: Math.min(
          window.innerHeight - 1,
          Math.max(0, targetBox.y + targetBox.height / 2),
        ),
      };

      return {
        uid,
        rect: {
          x: targetBox.x,
          y: targetBox.y,
          width: targetBox.width,
          height: targetBox.height,
          top: targetBox.y,
          right: targetBox.x + targetBox.width,
          bottom: targetBox.y + targetBox.height,
          left: targetBox.x,
        },
        interactionPoint,
        visibleRatio,
        intersectsViewport,
        pageUrl: location.href,
        pageTitle: document.title,
        viewport: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        minVisibleRatio,
      };
    },
    {
      targetBox: box,
      uid,
      minVisibleRatio: HIGHLIGHT_DEFAULT_MIN_VISIBLE_RATIO,
    },
  );

  return {
    ok:
      inspection.styleVisible &&
      payload.intersectsViewport &&
      payload.visibleRatio >= HIGHLIGHT_DEFAULT_MIN_VISIBLE_RATIO &&
      inspection.centerHit,
    uid,
    rect: payload.rect,
    interactionPoint: payload.interactionPoint,
    visibleRatio: payload.visibleRatio,
    intersectsViewport: payload.intersectsViewport,
    centerHit: inspection.centerHit,
    styleVisible: inspection.styleVisible,
    pageUrl: payload.pageUrl,
    pageTitle: payload.pageTitle,
    viewport: payload.viewport,
    elementPageUrl: inspection.elementPageUrl,
    elementPageTitle: inspection.elementPageTitle,
  };
}

async function stopScreenRecordingSession(
  session: RecordingSession,
  reason: string,
) {
  if (session.stopPromise) {
    return session.stopPromise;
  }

  clearAutoStopTimer(session);
  if (activeRecording === session) {
    activeRecording = null;
  }

  session.stopPromise = (async () => {
    const errors: string[] = [];

    try {
      await withTimeout(
        session.client.send('Page.stopScreencast'),
        STOP_STEP_TIMEOUT_MS,
        'CDP stopScreencast',
      );
    } catch (error) {
      errors.push(`CDP stopScreencast: ${(error as Error).message}`);
    }

    if (typeof session.client.off === 'function') {
      try {
        session.client.off('Page.screencastFrame', session.frameHandler);
      } catch {
        // Ignore listener removal errors.
      }
    }

    try {
      await withTimeout(
        session.getWriteChain(),
        STOP_STEP_TIMEOUT_MS,
        'Frame write flush',
      );
    } catch (error) {
      errors.push(`frame write flush: ${(error as Error).message}`);
    }

    try {
      await withTimeout(
        endWritableStream(session.ffmpeg.stdin),
        STOP_STEP_TIMEOUT_MS,
        'ffmpeg stdin close',
      );
    } catch (error) {
      errors.push(`ffmpeg stdin close: ${(error as Error).message}`);
      try {
        session.ffmpeg.stdin.destroy();
      } catch {
        // Ignore forced stdin destroy failures.
      }
    }

    let ffmpegExit: {
      code: number | null;
      signal: NodeJS.Signals | null;
    } | null = null;
    try {
      ffmpegExit = await withTimeout(
        waitForProcessExit(session.ffmpeg, STOP_STEP_TIMEOUT_MS),
        STOP_STEP_TIMEOUT_MS + 500,
        'ffmpeg exit',
      );
    } catch (error) {
      errors.push(`ffmpeg exit wait: ${(error as Error).message}`);
      try {
        session.ffmpeg.kill('SIGKILL');
      } catch {
        // Ignore kill failures while forcing ffmpeg shutdown.
      }
      try {
        ffmpegExit = await withTimeout(
          waitForProcessExit(session.ffmpeg, 2_000),
          2_500,
          'ffmpeg exit after SIGKILL',
        );
      } catch (followupError) {
        errors.push(`ffmpeg hard kill: ${(followupError as Error).message}`);
      }
    }

    await detachClient(session);

    const capturedFrames = session.getFrameCount();
    const durationMs = Math.max(0, Date.now() - session.startTimeMs);
    const writeFailure = session.getWriteFailure();
    const ffmpegText = session.ffmpegErrorTextRef();

    if (capturedFrames < 1) {
      throw new Error(
        'Recording stopped before any frames were captured. Keep recording active for at least a moment before stopping.',
      );
    }
    if (writeFailure) {
      errors.push(`frame writer: ${writeFailure.message}`);
    }
    if (!ffmpegExit || ffmpegExit.code !== 0) {
      const summary = (ffmpegText || '')
        .trim()
        .split('\n')
        .slice(-4)
        .join(' | ');
      errors.push(
        `ffmpeg exit code ${ffmpegExit?.code ?? 'unknown'} signal ${ffmpegExit?.signal ?? 'none'}${summary ? ` (${summary})` : ''}`,
      );
    }

    if (errors.length > 0) {
      throw new Error(
        `Recording finalization encountered errors: ${errors.join('; ')}`,
      );
    }

    return {
      ok: true,
      outputPath: session.outputPath,
      pageUrl: session.pageUrl,
      targetFps: session.targetFps,
      frameCount: capturedFrames,
      durationMs,
      autoStopped: reason === 'auto_timeout',
      stopReason: reason,
    };
  })();

  return session.stopPromise;
}

async function startRecordingAndHighlightSession(input: {
  uid: string;
  fileName?: string;
  fps?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  page: Page;
  handle: ElementHandle<Element>;
}) {
  await recoverActiveRecordingForStart();
  await ensureFfmpegAvailable();

  const outputPath = resolveRecordingOutputPath(input.fileName);
  const {options: screencastOptions, targetFps} = buildScreencastOptions(input);
  const ffmpegArgs = [
    '-y',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-framerate',
    String(targetFps),
    '-i',
    'pipe:0',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ];
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let ffmpegErrorText = '';
  ffmpeg.stderr.on('data', chunk => {
    ffmpegErrorText = `${ffmpegErrorText}${chunk.toString()}`;
    if (ffmpegErrorText.length > MAX_FFMPEG_STDERR_CHARS) {
      ffmpegErrorText = ffmpegErrorText.slice(-MAX_FFMPEG_STDERR_CHARS);
    }
  });

  await new Promise<void>((resolve, reject) => {
    ffmpeg.once('spawn', () => {
      resolve();
    });
    ffmpeg.once('error', error => {
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });
  });

  let client: CDPSession | null = null;
  let frameHandler: RecordingSession['frameHandler'] | null = null;
  let frameCount = 0;
  let writeChain = Promise.resolve();
  let writeFailure: Error | null = null;
  try {
    client = await input.page.target().createCDPSession();

    frameHandler = (frameEvent: {data: string; sessionId: number}) => {
      frameCount += 1;
      const frameBuffer = Buffer.from(frameEvent.data, 'base64');
      writeChain = writeChain
        .then(() => {
          return writeToStream(ffmpeg.stdin, frameBuffer);
        })
        .catch(error => {
          writeFailure = error as Error;
        });

      void client
        ?.send('Page.screencastFrameAck', {sessionId: frameEvent.sessionId})
        .catch(() => {
          // Ignore ack failures; they can happen while stopping.
        });
    };
    client.on('Page.screencastFrame', frameHandler);

    await client.send('Page.startScreencast', screencastOptions);
    const highlightPayload = await focusAndHighlightByUid(
      input.page,
      input.handle,
      input.uid,
    );
    if (!highlightPayload.ok) {
      throw new Error(
        `Failed to highlight uid ${input.uid}. Take a fresh snapshot and retry while the target is visibly in frame.`,
      );
    }

    const session: RecordingSession = {
      page: input.page,
      client,
      ffmpeg,
      frameHandler,
      ffmpegErrorTextRef: () => ffmpegErrorText,
      outputPath,
      pageUrl: input.page.url(),
      startTimeMs: Date.now(),
      targetFps,
      autoStopTimer: null,
      stopPromise: null,
      getFrameCount: () => frameCount,
      getWriteChain: () => writeChain,
      getWriteFailure: () => writeFailure,
    };
    session.autoStopTimer = setTimeout(() => {
      void clearHighlightOnPage(session.page)
        .catch(() => {
          // Ignore highlight clear errors for auto-timeout.
        })
        .finally(() => {
          void stopScreenRecordingSession(session, 'auto_timeout').catch(
            error => {
              console.error(
                `Auto-stop screen recording failed: ${error.message}`,
              );
            },
          );
        });
    }, AUTO_STOP_RECORDING_MS);
    if (typeof session.autoStopTimer.unref === 'function') {
      session.autoStopTimer.unref();
    }
    activeRecording = session;

    return {
      ok: true,
      outputPath,
      pageUrl: input.page.url(),
      targetFps,
      autoStopAfterMs: AUTO_STOP_RECORDING_MS,
      highlight: highlightPayload,
      message:
        'Recording started and highlight applied. Auto-stop runs after 300 seconds if not stopped earlier.',
    };
  } catch (error) {
    try {
      await clearHighlightOnPage(input.page);
    } catch {
      // Ignore clear failures during startup cleanup.
    }
    try {
      await client?.send('Page.stopScreencast');
    } catch {
      // Ignore stop failure during cleanup.
    }
    if (client && frameHandler && typeof client.off === 'function') {
      try {
        client.off('Page.screencastFrame', frameHandler);
      } catch {
        // Ignore listener removal failures.
      }
    }
    try {
      ffmpeg.kill('SIGKILL');
    } catch {
      // Ignore kill failures.
    }
    if (client) {
      await detachClient({
        page: input.page,
        client,
        ffmpeg,
        frameHandler: () => {},
        ffmpegErrorTextRef: () => ffmpegErrorText,
        outputPath,
        pageUrl: input.page.url(),
        startTimeMs: Date.now(),
        targetFps,
        autoStopTimer: null,
        stopPromise: null,
        getFrameCount: () => frameCount,
        getWriteChain: () => writeChain,
        getWriteFailure: () => writeFailure,
      });
    }
    throw error;
  }
}

async function clearHighlightAndStopRecording() {
  if (!activeRecording) {
    throw new Error('No active screen recording was found.');
  }
  const session = activeRecording;

  let highlightResult: Awaited<ReturnType<typeof clearHighlightOnPage>> | null =
    null;
  let highlightError: Error | null = null;
  try {
    highlightResult = await clearHighlightOnPage(session.page);
  } catch (error) {
    highlightError = error as Error;
  }

  let recordingPayload: StopRecordingPayload;
  try {
    recordingPayload = await stopScreenRecordingSession(session, 'manual');
  } catch (error) {
    const highlightContext = highlightError
      ? ` Highlight clear error: ${highlightError.message}`
      : '';
    throw new Error(
      `Failed to stop and finalize recording: ${(error as Error).message}.${highlightContext}`.trim(),
    );
  }

  return {
    ok: true,
    highlight: highlightResult ?? {
      ok: false,
      removed: 0,
      error: highlightError
        ? highlightError.message
        : 'Highlight clear result unavailable.',
    },
    recording: recordingPayload,
    outputPath: recordingPayload.outputPath,
    frameCount: recordingPayload.frameCount,
    durationMs: recordingPayload.durationMs,
    autoStopped: recordingPayload.autoStopped,
    stopReason: recordingPayload.stopReason,
  };
}

async function forceStopActiveRecording() {
  if (!activeRecording) {
    return;
  }
  const session = activeRecording;
  try {
    await stopScreenRecordingSession(session, 'forced_shutdown');
    return;
  } catch {
    // Fall back to hard stop during forced shutdown.
  }

  await hardCleanupRecordingSession(session);
}

export const startRecordingAndHighlight = definePageTool({
  name: 'start_recording_and_highlight',
  description:
    'Start screen recording and apply a deterministic highlight to a target uid on the selected page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    uid: zod
      .string()
      .describe(
        'The uid of an element on the page from the page content snapshot.',
      ),
    fileName: zod
      .string()
      .optional()
      .describe(
        'Optional file name for the MP4 saved in the OS Downloads directory.',
      ),
    fps: zod.number().int().min(1).max(60).optional(),
    quality: zod.number().int().min(1).max(100).optional(),
    maxWidth: zod.number().int().positive().optional(),
    maxHeight: zod.number().int().positive().optional(),
  },
  handler: async (request, response) => {
    let handle: ElementHandle<Element> | null = null;
    try {
      handle = await request.page.getElementByUid(request.params.uid);
    } catch (error) {
      throw new Error(
        `Failed to resolve uid ${request.params.uid}. Take a fresh snapshot and retry.`,
        {cause: error as Error},
      );
    }

    try {
      const payload = await startRecordingAndHighlightSession({
        uid: request.params.uid,
        fileName: request.params.fileName,
        fps: request.params.fps,
        quality: request.params.quality,
        maxWidth: request.params.maxWidth,
        maxHeight: request.params.maxHeight,
        page: request.page.pptrPage,
        handle,
      });
      response.appendResponseLine(JSON.stringify(payload));
    } finally {
      await handle.dispose();
    }
  },
});

export const clearHighlightAndStopRecordingTool = definePageTool({
  name: 'clear_highlight_and_stop_recording',
  description:
    'Best-effort clear active highlight, then stop and finalize the active recording.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response) => {
    const payload = await clearHighlightAndStopRecording();
    response.appendResponseLine(JSON.stringify(payload));
  },
});

process.on('SIGINT', () => {
  void forceStopActiveRecording().finally(() => {
    process.exit(0);
  });
});
process.on('SIGTERM', () => {
  void forceStopActiveRecording().finally(() => {
    process.exit(0);
  });
});
process.on('exit', () => {
  if (activeRecording) {
    try {
      activeRecording.ffmpeg.kill('SIGKILL');
    } catch {
      // Ignore kill failure while exiting.
    }
  }
});
