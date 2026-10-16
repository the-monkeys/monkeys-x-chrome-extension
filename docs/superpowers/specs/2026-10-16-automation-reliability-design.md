# Browser automation reliability

Approved scope: a bounded persistent queue, one active job, at most three managed
tabs, periodic health checks, recovery, and bounded safe retries. Existing
username/Studio configuration and enforced Midnight remain in place.

- Persist up to 100 unfinished requests, 50 terminal records and 1,000 completed
  identifiers. A full queue rejects new work visibly; it never acknowledges work
  it did not save. Deduplication includes the configured account.
- Serialize all coordinator mutations. Track one notifications tab, one Studio
  tab and one reply tab. Never navigate an unrelated user tab to post a reply.
- Correlate every content-script operation with job and attempt IDs and the
  managed tab. Ignore old, duplicate and wrong-tab callbacks.
- Stages: queued -> rendering -> awaiting_approval/reply_ready -> posting -> posted.
  Safe errors retry at most three attempts with cooldown; exhausted jobs fail.
  A possibly submitted reply becomes needs_review, blocks the queue, and is never
  automatically submitted again. The user can mark it posted or skip it.
- Persist posting authorization before clicking Reply. Mark success only after
  a new X success toast. A timeout, worker/browser restart or missing tab after
  authorization is ambiguous and requires review.
- A one-minute Chrome alarm checks managed tabs, stalled stages and notification
  script responsiveness. Refresh notifications at most once every three minutes;
  do not refresh while full. Recreate closed managed tabs without multiplying them.
- Reapply optional system keep-awake while monitoring, allowing the display to
  turn off. Sleep/hibernation/shutdown and network availability remain external
  constraints. Queue recovery resumes after waking; no real-time guarantee while
  the device sleeps and no guarantee of discovering all historical X mentions.
- Start/Pause, queue status, approval/review actions and health errors are visible
  in the popup. Honor Auto Reply; when disabled, a screenshot waits for approval.
- No X API, external scheduler, OS settings changes, or changes to existing user
  tabs outside the notifications workflow. Follower/media eligibility is outside
  this reliability change and must not be represented as implemented here.

Validation: simulated concurrent 100-request bursts and overflow; persistent
restart; tab closure; stale/duplicate callbacks; timeout and retry limits;
submission ambiguity; background polling; permission failures; existing tests;
TypeScript and production build. Real laptop sleep and live X posting require
manual browser validation.
