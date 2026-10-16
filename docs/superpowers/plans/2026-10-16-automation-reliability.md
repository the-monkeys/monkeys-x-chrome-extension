# Reliability implementation

Design: ../specs/2026-10-16-automation-reliability-design.md
Execute inline in the current checkout, preserving the user's staged changes.

1. Add the persisted coordinator and tests. Own queue admission, account-scoped
   deduplication, three tab roles, job leases and callbacks, bounded retry,
   alarms/keep-awake, and manual review controls. Tests use a persistent fake
   Chrome boundary and a controllable clock. Run npm test.
2. Route background events to the coordinator. Make notification admission
   acknowledgement-based and rescan on health checks. Make Studio execution and
   replies use attempt IDs and coordinator-owned payloads. Authorize replies
   before clicking; confirm via a new success toast. Run npm test and build.
3. Expose state and controls in the popup, add keep-awake setting, and document
   operational limits. Verify the complete suite, build and diff; request one
   independent read-only review and address substantive findings.

Review focus: worker restart around Reply click; closed tabs during rendering;
full queue without silent acknowledgement; late content callbacks; paused jobs;
configuration changes with queued work; background script re-entry; legacy pending
reply migration; image storage bounds and no use of unrelated user reply tabs.

## Execution record

- Implemented inline in the existing checkout to retain the current extension
  changes. No changes were staged or committed by this task.
- Queue/coordinator, content-script protocol, popup controls and power/alarm
  integration are implemented. `npm test`: 32/32 passed. `npm run build`: passed
  using the permitted build escalation for Windows sandbox realpath restrictions.
- Independent review findings fixed with reproducing tests: stale popup job
  actions; missing refresh cooldown on an unresponsive page; tab ID reuse across
  browser sessions; legacy pending reply review linking to the wrong target.
- Additional recovery tests cover the create/save crash window and Studio origin
  changes across browser restart. Screenshots and posts are correlated by attempt.
- Live X/Studio loading behavior, uploads/posting, background throttling, and
  physical sleep recovery require manual browser validation. Tests simulate these
  boundaries; they do not claim a live post or real sleep cycle was performed.

## Operating check

Reload the unpacked `dist` extension and refresh existing X tabs. Check the
configured username matches the account signed into X. Enable Auto Reply on
Mention for unattended replies; otherwise the queue waits for screenshot approval.
Keep laptop awake prevents automatic idle sleep while monitoring, allows display
off, and is released by Pause. It does not override shutdown or manual sleep.
If a reply needs review, inspect its linked X post, then mark posted or skip. The
extension does not automatically repeat an uncertain submission.

## Screenshot transfer / stalled retry correction

- A tab message with an open, unanswered response channel could hold the serial
  controller lock indefinitely. Tab signals and health probes now have a five
  second response timeout; a regression verifies that saved retries still run.
- Studio's raster export defaults to pixel ratio 2. Large PNGs are resized to a
  maximum edge of 1600 pixels and encoded as JPEG before sending base64. Small
  PNG/JPEG exports stay unchanged; intermediate SVGs are ignored. Errors retain
  their attempt token and distinguish missing data, unsupported format and size.
- The popup shows the scheduled retry time. New attempts clear the old error.
- Verification: 42/42 tests pass and the production build passes. A real canvas
  browser fixture at tests/fixtures/studio-export.html verified a 20,065,470-byte
  PNG becomes a valid 1280 x 1600 JPEG with 1,955,631 data URL characters, below
  the coordinator's 6,000,000-character limit. Independent focused review found
  no critical or important issues. The temporary local test server was stopped.
- Regular Chrome was not connected to computer-use tools, so the user's exact
  rejected payload and live X reply path remain unverified. This browser fixture
  verifies image transfer only; it does not verify the full X/Studio workflow.

## Reply composer correction

- User evidence showed a duplicated caption without an image after approval.
  Reproduced a no-form composer selecting an unrelated global upload input and
  an upload timeout leaving a caption-only draft. Controls are now found in the
  same composer, with a unique visible editor; an attachment preview must appear
  before the caption is inserted into an explicit editor selection.
- A persisted composition claim prevents two script instances from preparing
  the same attempt. Existing/changed drafts pause automation without appending.
  Explicit Start allows preparation again after correction. Paused preparation
  no longer expires while the user fixes a draft or account conflict.
- Verification: 48/48 tests and production build pass. The browser fixture at
  tests/fixtures/status/1/index.html ran the built content script against a real
  contenteditable and file input, with a hidden decoy editor, unrelated upload
  input, and repeated triggers. It reported one caption, one attached image,
  one submit click and zero unrelated uploads. This is a local fixture using
  a simulated runtime/success receipt, not a post to X. Focused review found
  and reproduced the paused-expiry issue, which was fixed and retested.
- Actual X composer structure and live media upload still require validation
  in the user's Chrome, which remains unconnected to the available tools.

## Persistent diagnostics and build verification

- v1.0.1 exposes Diagnostics in the popup with a timestamp build ID shared by
  the worker and content scripts, observed script versions/tab IDs, target URL,
  last checkpoint and a Download diagnostics button. Reports contain at most
  300 persisted events and 30 script records. They omit image data, cookies,
  HTML, tweet bodies, API keys and full attempt tokens. Report retrieval is
  restricted to extension UI; content telemetry is checked against its origin.
- Current work retrieval, screenshot receipt, composition and post claims reject
  scripts with old or missing build IDs. Refresh X and Studio after reloading
  the extension. A popup still showing v1.0.0 is an older installed copy.
- Reply logs distinguish editor selection, control discovery, file assignment,
  attachment preview, caption insertion, button readiness, click and receipt.
  Content traces carry producer identity; late traces are marked stale rather
  than attributed to the current attempt. Lifecycle events carry no job ID.
- Studio's own single-post fetch is observed through a cloned response only
  while work is armed. Its returned ID, text length, mention counts and display
  text range are logged without response bodies or credentials. This enables
  diagnosis of the reported extra leading mention without altering content.
- User reaffirmed this/current means the command reply; above means its direct
  parent. Unverified parents are skipped and logged, never guessed. Relationship
  metadata that appears later remains eligible for a subsequent scan.
- Verification: 54 tests pass, production build passes, classic content scripts
  parse without module imports. Local browser fixture using built reply code
  reported one caption/image/click and checkpoints in attachment-before-caption
  order. Independent review identified trace-correlation gaps; regressions and
  fixes cover late attempts and separately queued requests. Live X remains
  unverified because regular Chrome is not connected to available tools.

To capture a live failure: reload the unpacked dist extension, refresh X/Studio,
verify Diagnostics says v1.0.1, clear the previous failed draft, and reproduce
one request. Download monkeys-diagnostics.json from the popup. Alternatively,
connect the official ChatGPT Chrome extension via Settings > Computer Use and
select @Chrome in the chat for direct browser inspection.

## Background export correction (v1.0.2)

- User diagnostics showed matching builds and target, Midnight selected and
  Copy clicked, then no image received before the rendering lease expired.
  Health checks continued. Auto Reply was false, so a later successful transfer
  would still require explicit approval before posting.
- Inspected the deployed html-to-image renderer: after Image.decode it waits
  for requestAnimationFrame. Chrome pauses such frames in background tabs.
  Direct Studio UI inspection also reproduced enabled export buttons while
  the preview still displayed Loading post.
- Automated jobs now verify MAIN bridge protocol 2, wait for the loaded preview,
  and use Download's blob path instead of clipboard access. Authorized exports
  race native animation frames against a 100 ms timer, preserving native
  callback delivery and cancellation after export ends. Manual rendering stays
  unchanged. A 60 second watchdog reports the actual export step; progress logs
  include bridge readiness, visibility, frame fallback and captured blob size.
- Verification: 56 tests and the production build pass. A real browser fixture
  using Studio's deployed renderer with native frames deliberately held produced
  a valid 1080 x 1350 PNG (1,443,190 data URL characters), with fallback observed.
  Independent review found callback loss after token removal; a red/green
  regression and fix preserve callbacks after completion. The fixture is not
  a live X reply test or an actual Chrome sleep cycle.
- Reload the extension, confirm v1.0.2 and refresh X/Studio. Approve an existing
  awaiting-approval request; enable Auto Reply and save for subsequent requests
  to run without that approval. A visible Studio preview alone does not confirm
  transfer: the popup must reach awaiting approval or reply preparation.
