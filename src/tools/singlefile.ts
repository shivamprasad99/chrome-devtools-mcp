/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {zod} from '../third_party/index.js';
import type {Page} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

const DEFAULT_TIMEOUT_MS = 90_000;

type SingleFileController = {
  capture(
    urls: Array<string | [string, Record<string, unknown>]>,
  ): Promise<void>;
  finish(): Promise<void>;
};

type SingleFileApi = {
  initialize(options: Record<string, unknown>): Promise<SingleFileController>;
};

function browserServerFromPage(page: Page): string {
  const endpoint = page.browser().wsEndpoint();
  if (!endpoint) {
    throw new Error(
      'Unable to resolve the browser websocket endpoint for SingleFile capture.',
    );
  }

  const url = new URL(endpoint);
  const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${url.host}`;
}

async function createOutputPath(filePath?: string): Promise<string> {
  if (filePath) {
    return path.resolve(filePath);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'singlefile-capture-'));
  return path.join(dir, 'capture.html');
}

async function captureWithSingleFileCli(input: {
  page: Page;
  filePath?: string;
  timeoutMs: number;
  waitDelayMs?: number;
}): Promise<{
  ok: boolean;
  outputPath: string;
  pageUrl: string;
  pageTitle: string;
  browserServer: string;
  sizeBytes: number;
}> {
  const outputPath = await createOutputPath(input.filePath);
  await fs.mkdir(path.dirname(outputPath), {recursive: true});

  const pageUrl = input.page.url();
  const pageTitle = await input.page.title();
  const browserServer = browserServerFromPage(input.page);

  const api =
    (await import('single-file-cli/single-file-cli-api.js')) as SingleFileApi;
  const controller = await api.initialize({
    browserServer,
    browserLoadMaxTime: input.timeoutMs,
    browserCaptureMaxTime: input.timeoutMs,
    browserWaitUntil: 'load',
    browserWaitUntilDelay: input.waitDelayMs ?? 500,
    compressHTML: true,
    blockScripts: true,
    insertSingleFileComment: true,
    filenameConflictAction: 'overwrite',
    output: outputPath,
  });

  try {
    await controller.capture([pageUrl]);
  } finally {
    await controller.finish();
  }

  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(
      `SingleFile capture did not produce a non-empty file: ${outputPath}`,
    );
  }

  return {
    ok: true,
    outputPath,
    pageUrl,
    pageTitle,
    browserServer,
    sizeBytes: stat.size,
  };
}

export const captureSingleFile = definePageTool({
  name: 'capture_singlefile',
  description:
    'Capture the selected page URL as a self-contained SingleFile HTML artifact using the active Chrome DevTools browser session.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute path, or a path relative to the current working directory, to save the SingleFile HTML artifact.',
      ),
    timeoutMs: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        `Maximum time to wait for SingleFile page loading and capture. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      ),
    waitDelayMs: zod
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Additional delay after page load before capture, in milliseconds. Defaults to 500.',
      ),
  },
  handler: async (request, response) => {
    const payload = await captureWithSingleFileCli({
      page: request.page.pptrPage,
      filePath: request.params.filePath,
      timeoutMs: request.params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      waitDelayMs: request.params.waitDelayMs,
    });
    response.appendResponseLine(JSON.stringify(payload));
  },
});
