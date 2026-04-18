/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParsedArguments} from '../bin/chrome-devtools-mcp-cli-options.js';

import * as consoleTools from './console.js';
import * as emulationTools from './emulation.js';
import * as extensionTools from './extensions.js';
import * as inPageTools from './inPage.js';
import * as inputTools from './input.js';
import * as lighthouseTools from './lighthouse.js';
import * as memoryTools from './memory.js';
import * as networkTools from './network.js';
import * as pagesTools from './pages.js';
import * as performanceTools from './performance.js';
import * as screencastTools from './screencast.js';
import * as screenshotTools from './screenshot.js';
import * as scriptTools from './script.js';
import * as slimTools from './slim/tools.js';
import * as snapshotTools from './snapshot.js';
import * as trustpulseRecordingTools from './trustpulse-recording.js';
import type {ToolDefinition} from './ToolDefinition.js';
import * as webmcpTools from './webmcp.js';

const TRUSTPULSE_EXCLUDED_TOOLS = new Set<string>([
  'drag',
  'emulate',
  'lighthouse_audit',
  'performance_analyze_insight',
  'performance_start_trace',
  'performance_stop_trace',
  'resize_page',
  'screencast_start',
  'screencast_stop',
  'take_memory_snapshot',
]);

export const createTools = (args: ParsedArguments) => {
  const rawTools = args.slim
    ? Object.values(slimTools)
    : [
        ...Object.values(consoleTools),
        ...Object.values(emulationTools),
        ...Object.values(extensionTools),
        ...Object.values(inPageTools),
        ...Object.values(inputTools),
        ...Object.values(lighthouseTools),
        ...Object.values(memoryTools),
        ...Object.values(networkTools),
        ...Object.values(pagesTools),
        ...Object.values(performanceTools),
        ...Object.values(screencastTools),
        ...Object.values(screenshotTools),
        ...Object.values(scriptTools),
        ...Object.values(snapshotTools),
        ...Object.values(trustpulseRecordingTools),
        ...Object.values(webmcpTools),
      ];

  const tools = [];
  for (const tool of rawTools) {
    if (typeof tool === 'function') {
      tools.push(tool(args) as unknown as ToolDefinition);
    } else {
      tools.push(tool as ToolDefinition);
    }
  }

  const filteredTools = tools.filter(tool => {
    return !TRUSTPULSE_EXCLUDED_TOOLS.has(tool.name);
  });

  filteredTools.sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  return filteredTools;
};
