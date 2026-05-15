/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare module 'single-file-cli/single-file-cli-api.js' {
  export function initialize(options: Record<string, unknown>): Promise<{
    capture(
      urls: Array<string | [string, Record<string, unknown>]>,
    ): Promise<void>;
    finish(): Promise<void>;
  }>;
}
