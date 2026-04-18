# TrustPulse Highlight + Recording Port Plan

## Objective

Port the TrustPulse browser-helper flow into this `chrome-devtools-mcp` fork so the fork exposes exactly two TrustPulse-specific tools:

- `start_recording_and_highlight`
- `clear_highlight_and_stop_recording`

The new `start_recording_and_highlight` tool should be `uid`-first and use the same element identity model as existing DevTools tools such as `click` and `take_screenshot`.

The original DevTools screencast tools remain ignored in this fork.

## Desired End State

After this change:

- the fork exposes the two TrustPulse tools above
- `start_recording_and_highlight` accepts a DevTools snapshot `uid` as its primary target
- the highlight and the subsequent `click` can operate on the same resolved element identity
- recording output is still saved to the OS Downloads directory by default
- recording still auto-stops after 300 seconds and finalizes the MP4 safely
- the built-in `screencast_start` and `screencast_stop` tools stay hidden/unavailable

## Current State

### In the TrustPulse helper MCP

Current behavior lives in:

- `browser-helpers-mcp/index.mjs`

It already provides:

- combined highlight + recording start
- combined clear highlight + stop recording
- ffmpeg-backed MP4 recording
- Downloads-directory default output
- 300 second auto-stop
- stale session recovery and hard cleanup

But it resolves the target by CSS selector, not DevTools `uid`, so it cannot reliably share the exact same target identity as `chrome-devtools-mcp`.

### In the DevTools MCP fork

Relevant current behavior:

- `click`, `hover`, `fill`, `take_screenshot`, and `evaluate_script` already work from snapshot `uid`
- `uid` values are generated and reused by the in-memory snapshot lifecycle in `McpContext`
- built-in screencast tools are already excluded from the effective tool surface in this fork

This means the correct place to solve the UID mismatch is inside this fork, not in a separate companion MCP.

## Requirements

### Functional requirements

- Add `start_recording_and_highlight` as a page-scoped tool.
- Add `clear_highlight_and_stop_recording` as a page-scoped tool.
- Make `uid` required on `start_recording_and_highlight`.
- Reuse the existing helper MCP behavior for:
  - Downloads-directory output default
  - ffmpeg-based MP4 finalization
  - auto-stop after 300 seconds
  - best-effort highlight clear before stop
  - stale-session recovery and hard cleanup
- Ignore the original DevTools screencast tools entirely for TrustPulse usage.

### Compatibility requirements

- Target resolution must use the same `request.page.getElementByUid(uid)` flow used by `click`.
- The tool must fail cleanly if the supplied `uid` is stale or the element no longer exists.
- The clear/stop flow must still save the recording even if the previously highlighted element is gone after navigation.
- The new tools must coexist with the existing reduced TrustPulse tool surface.

## Non-goals

- Do not reintroduce `screencast_start` or `screencast_stop`.
- Do not keep a separate selector-first highlighting contract as the primary API.
- Do not preserve the separate `browser-helpers-mcp` runtime for the final steady state.
- Do not broaden the tool surface beyond the two TrustPulse tools.

## Tool Contracts

### `start_recording_and_highlight`

Proposed input shape:

- `uid` required string
- `fileName` optional string
- `fps` optional integer `1-60`, default `15`
- `quality` optional integer `1-100`, default `80`
- `maxWidth` optional positive integer
- `maxHeight` optional positive integer

Notably absent:

- no `selector`
- no `pageUrlSubstring`

Reason:

- inside DevTools MCP, the selected page or routed `pageId` already identifies the page
- the `uid` already identifies the element within the current snapshot lifecycle

Expected behavior:

- resolve the element from `uid`
- scroll it deterministically into view
- verify visibility and center-point hittability
- draw the red overlay box
- start the recording session
- return output metadata and highlight diagnostics

### `clear_highlight_and_stop_recording`

Input shape:

- no arguments

Expected behavior:

- best-effort clear the active overlay
- stop and finalize recording
- return output path and recording metadata
- do not fail the save just because highlight clearing could not reach the original element/page state

## Design Decisions

### 1. Keep the TrustPulse flow as two combined tools

Do not split recording and highlighting back apart.

Reason:

- this preserves the current TrustPulse workflow
- it reduces agent decision overhead
- it avoids partially completed highlight/record states

### 2. Make the implementation page-scoped inside DevTools MCP

Implement the two tools as standard page tools in this fork.

Reason:

- `request.page` already gives access to the selected page
- `pageId` routing works automatically if enabled
- `uid` resolution can use the exact same internal state as `click`

### 3. Reuse helper recording internals, not original DevTools screencast behavior

Port the helper MCP recording pipeline rather than building on the deprecated forked-out screencast tools.

Reason:

- helper behavior already matches TrustPulse needs
- built-in screencast behavior differs on output location and lifecycle
- helper logic already contains the 300 second auto-stop and stale cleanup behavior that TrustPulse asked for

### 4. Highlight by resolved element handle, not by selector

The tool should resolve the target through `uid`, then derive geometry from the element handle in the page context.

Reason:

- this removes the current mismatch between highlight targeting and click targeting
- it avoids brittle selector logic on component libraries such as Element UI

## Proposed Implementation Shape

### Files to add or update in the fork

Primary implementation:

- `src/tools/trustpulse-recording.ts`
- `src/tools/tools.ts`
- `src/McpContext.ts`

Possible type/support updates:

- `src/tools/categories.ts` if category placement needs adjustment
- `src/tools/ToolDefinition.ts` only if a shared helper type becomes necessary

Docs/tests/generated artifacts:

- `docs/tool-reference.md`
- `tests/index.test.ts`
- any tool-catalog or generated-doc snapshots affected by the new tools

## Tool registration

Add the new TrustPulse tool module to `src/tools/tools.ts`.

Keep `screencast_start` and `screencast_stop` in the denylist so they remain unavailable.

## Context state

Add a dedicated recording session slot to `McpContext`, separate from the original screencast recorder state.

Suggested shape:

- active TrustPulse recording session or `null`
- getters/setters for the session

The session should store:

- target page identity
- CDP session
- ffmpeg process
- output path
- auto-stop timer
- frame handler
- frame/write bookkeeping
- stop promise
- start time
- target fps

Use a single active recording at a time per MCP server instance.

Reason:

- this matches current TrustPulse behavior
- it simplifies failure recovery

## Highlight implementation

Port the helper overlay logic but change element targeting from selector lookup to handle-backed evaluation.

Implementation outline:

1. Resolve the element handle from `uid`.
2. Run page-side logic against that exact element.
3. Scroll relevant scroll containers and the page viewport to center the element vertically.
4. Measure bounding rect and visible ratio.
5. Check center hit testing with `elementFromPoint`.
6. Draw the overlay using fixed-position DOM nodes with stable IDs.
7. Install cleanup hooks for navigation lifecycle events such as:
   - `pagehide`
   - `beforeunload`
   - `pageshow`
   - `popstate`

Important detail:

- highlight clearing should remove overlay nodes by known DOM IDs
- it should not require the original element to still exist

That solves the case where the highlighted element disappears after navigation but the overlay cleanup still needs to happen.

## Recording implementation

Port these helper behaviors substantially unchanged:

- Downloads-directory path resolution
- filename sanitization
- ffmpeg presence check
- CDP `Page.startScreencast` frame streaming
- write flush + ffmpeg finalization
- `Page.stopScreencast` timeout handling
- hard cleanup on failure
- 300 second auto-stop
- stale active-session recovery before starting a new recording

This keeps behavior stable relative to the current helper MCP.

## Error handling requirements

### Start path

If `uid` is stale:

- fail with a message equivalent in spirit to existing `click` failures
- instruct the caller to take a fresh snapshot and retry

If recording state is stale:

- attempt graceful stop
- fall back to hard cleanup
- allow a fresh recording to start afterward

### Stop path

If no active recording exists:

- return a clean error

If overlay clear fails:

- continue stopping and saving the recording
- report the highlight-clear failure in the result/error context

If the page navigated:

- best-effort clear on the current live page/document
- do not require the original highlighted element to still exist

## Migration Impact Outside the Fork

These changes are necessary for TrustPulse to actually consume the new tools.

### Runner changes in TrustPulse

Update runtime wiring so TrustPulse uses the fork instead of:

- `chrome-devtools-mcp@latest`
- separate `browser-helpers-mcp`

Specifically:

- point the DevTools MCP entry to the local fork build/package
- remove `browser-helpers` MCP injection from the Codex and OpenCode runtimes

### Prompt changes in TrustPulse

Update onboarding prompts from selector-based guidance to UID-based guidance.

Current wording that must change:

- “identify an anchor element selector”
- “call `start_recording_and_highlight`” in selector-oriented form

New guidance should be:

- take a snapshot
- identify the target `uid`
- call `start_recording_and_highlight` with that `uid`
- perform the action using the same `uid` when applicable
- stop via `clear_highlight_and_stop_recording`

### Runtime tests in TrustPulse

Existing tests that assert browser-helper MCP injection will need to be replaced with tests asserting:

- the forked DevTools MCP is configured
- no extra helper MCP is injected

## Detailed Execution Plan

1. Add the new TrustPulse recording/highlight module to the fork.

- Create a new page-tool module for the two tools.
- Port helper utilities for Downloads resolution, ffmpeg, cleanup, and overlay management.

2. Introduce TrustPulse recording session state in `McpContext`.

- Add getters/setters for the active session.
- Keep this separate from any legacy screencast state.

3. Rewrite highlight targeting around `uid`.

- Use `request.page.getElementByUid(uid)` to resolve the exact target.
- Move page-side overlay logic from selector search to direct element-handle evaluation.

4. Register the new tools in `src/tools/tools.ts`.

- Keep built-in screencast tools excluded.
- Ensure the new TrustPulse tools remain exposed in normal mode.

5. Update fork docs/tests/generated outputs.

- Regenerate tool reference output if needed.
- Update tool-catalog tests to expect the two new tools.

6. Validate behavior locally in the fork.

- start recording on a known `uid`
- verify overlay appears on the intended element
- click the same `uid`
- stop and verify the MP4 lands in Downloads
- verify auto-stop after 300 seconds
- verify a stale session can recover

7. Migrate TrustPulse runtime wiring.

- switch the MCP entry from upstream `@latest` to the fork
- remove browser-helper MCP injection
- update prompt text from selector wording to UID wording

8. Run end-to-end onboarding smoke coverage.

- confirm the agent can take snapshot, choose `uid`, highlight, click, screenshot, and stop recording in one browser session

## Validation Checklist

Fork behavior:

- [ ] `start_recording_and_highlight` is exposed
- [ ] `clear_highlight_and_stop_recording` is exposed
- [ ] `screencast_start` is not exposed
- [ ] `screencast_stop` is not exposed
- [ ] `start_recording_and_highlight` requires `uid`
- [ ] a valid `uid` highlights the same element later used by `click`
- [ ] recordings save to the OS Downloads directory by default
- [ ] recording auto-stops after 300 seconds and finalizes
- [ ] a failed stop does not leave the server permanently stuck in an active-recording state

Failure-path validation:

- [ ] stale `uid` produces a clear retry message
- [ ] clearing highlight after navigation does not block recording finalization
- [ ] restarting after a stale/broken recording session works

TrustPulse integration:

- [ ] runtime no longer injects separate browser-helper MCP
- [ ] prompts instruct the agent to work from `uid`, not selector
- [ ] onboarding smoke run succeeds with the forked MCP only

## Risks and Mitigations

Risk: `uid` is only valid relative to the latest snapshot state.

Mitigation:

- keep failure messages explicit
- make prompt guidance tell the agent to take a fresh snapshot before choosing the `uid`

Risk: overlay and recording state can diverge during navigation.

Mitigation:

- clear overlays by fixed DOM IDs
- make stop/save independent from original element existence
- retain auto-stop and hard cleanup

Risk: TrustPulse still points to upstream `chrome-devtools-mcp@latest`.

Mitigation:

- treat runner migration as part of rollout, not an optional follow-up

Risk: duplicate state with legacy screencast code in the fork causes confusion.

Mitigation:

- keep original screencast tools excluded
- keep the new TrustPulse session state explicitly separate

## Rollout Notes

- This should be implemented as a fork-specific TrustPulse capability, not as a generic replacement for all DevTools MCP recording APIs.
- The fork should become the single source of truth for TrustPulse browser automation, screenshots, highlight overlays, and screen recordings.
