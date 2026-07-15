# Monkeys X Automation — Chrome Extension & Backend Plan

> **Status:** Planning only — no implementation yet.  
> **Goal:** Automatically respond on X when someone tags `@monkeys`, using our branded X-Screenshot feature, and also publish curated business/tech tweets sourced from the **Orbitor** platform.

---

## 1. Problem statement

Today, Monkeys Snapshot Studio (`/snapshot`) can manually:

1. Paste an X post URL.
2. Style it (theme, gradient, watermark, card toggles).
3. Export a branded PNG (or composed MP4 for video tweets).

We want to **automate** two workflows:

| Workflow | Trigger | Action |
|---|---|---|
| **A. Mention reply** | A user tags `@monkeys` (or configured handle) in a post/reply | Generate branded screenshot of *that* post → reply under it with the image |
| **B. Curated repost** | Orbitor feed supplies business/tech tweet candidates | Generate screenshot → publish as a new post or quote/reply from the Monkeys account |

A Chrome extension is the **control surface and optional local runner**, but production reliability requires a **backend orchestrator** (extension alone cannot run 24/7 or bypass X API limits cleanly).

---

## 2. What we already have (reuse)

| Asset | Location | Reuse for automation |
|---|---|---|
| Tweet syndication proxy | `GET /api/snapshot/tweet/[id]` | Fetch tweet JSON by ID (public posts) |
| X-Screenshot preview UI | `TweetScreenshotPreview.tsx` | Visual reference; not headless-ready as-is |
| Screenshot options contract | `TweetScreenshotOptions` | Pass theme, aspect, toggles to render API |
| Client PNG export | `html-to-image` via `useExport` | Works in browser only |
| Branded video compose | `POST /api/snapshot/tweet/video/render` | Video tweets; gateway + FFmpeg |
| Theme presets | `themes.ts` + `getTweetCanvasBackground` | Default automation styling |
| Meta-feed (blogs) | `POST /blog/meta-feed` (API v2) | Related content, **not** tweet IDs — Orbitor is separate |

**Gap:** There is **no server-side PNG render endpoint** for X screenshots yet. The cast/Satori sidecar mentioned in `types.ts` is the intended long-term path but is not wired for tweet cards today. Automation **depends** on adding this (or a Puppeteer render worker).

**Gap:** No X posting/mentions integration exists in this repo.

**Gap:** **Orbitor** is not referenced in this codebase. Section 6 defines the integration contract we need from that platform.

---

## 3. Recommended architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Chrome Extension (MV3)                          │
│  popup: settings · queue · manual “screenshot this tweet”             │
│  optional: OAuth token handoff · approve-before-post UI                 │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTPS + extension API key / user JWT
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Monkeys Orchestrator (new — monkeys_engine or Next API)    │
│  · poll X mentions OR receive Orbitor webhooks                          │
│  · dedupe + rate limit + moderation queue                               │
│  · call Snapshot Render Service                                         │
│  · upload media to X · create reply/tweet via X API v2                  │
└───────────────┬─────────────────────────────┬───────────────────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌─────────────────────────────────────────┐
│ Snapshot Render Service   │   │ Orbitor Platform                        │
│ PNG (+ optional MP4)      │   │ curated tweet feed: business, tech, …  │
│ Satori / Puppeteer /      │   │ (API TBD — see §6)                      │
│ headless Snapshot page    │   └─────────────────────────────────────────┘
└───────────────────────────┘
                │
                ▼
┌───────────────────────────┐
│ X (Twitter) API v2        │
│ mentions · media upload   │
│ · POST /2/tweets          │
└───────────────────────────┘
```

### Why not “extension-only”?

| Concern | Extension-only | Backend orchestrator |
|---|---|---|
| Runs when browser closed | No | Yes |
| X API secret storage | Risky in extension | Server-side vault |
| Rate limits & retries | Fragile | Queue + backoff |
| Screenshot render | Offscreen doc / hidden tab hack | Dedicated render worker |
| Audit / moderation | Hard | DB + admin UI |

**Recommendation:** Build the **orchestrator as the source of truth**. The extension is for auth, settings, manual triggers, and optional human-in-the-loop approval.

---

## 4. Chrome extension design (Manifest V3)

### 4.1 Package layout (proposed monorepo path)

```
apps/monkeys_x_extension/
  manifest.json
  package.json
  src/
    background/          # service worker — alarms, message routing
    content/             # x.com — detect tweet context, inject actions
    popup/               # React or plain HTML settings + queue status
    offscreen/           # optional — only if we client-render PNGs
    lib/
      api.ts             # calls Monkeys orchestrator
      storage.ts         # chrome.storage.sync
  icons/
```

### 4.2 Permissions (minimal)

```json
{
  "permissions": ["storage", "alarms", "notifications"],
  "host_permissions": [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://monkeys.com.co/*",
    "https://monkeys.support/*"
  ],
  "optional_host_permissions": []
}
```

Avoid `<all_urls>` unless strictly required.

### 4.3 Extension responsibilities

| Feature | Phase | Description |
|---|---|---|
| **Settings** | 1 | Default theme, aspect, auto-reply on/off, Orbitor categories |
| **Manual capture** | 1 | On x.com/status/:id — button “Monkeys Screenshot” → preview → post reply |
| **Mention inbox (read-only)** | 2 | Show pending mentions fetched from orchestrator |
| **Approve & post** | 2 | Human approves queued screenshots before reply |
| **OAuth assist** | 2 | Start X OAuth PKCE flow; send tokens to orchestrator (never store client secret in extension) |
| **Local polling (fallback)** | 3 | Alarm every N minutes *if* user keeps browser open — not primary path |

### 4.4 Content script behaviour (x.com)

On `/status/:tweetId` pages:

1. Parse `tweetId` from URL.
2. Inject a small Monkeys action chip near the post toolbar.
3. On click → `POST /api/x-automation/jobs` with `{ type: "mention_reply", tweetId, replyToTweetId: tweetId }`.
4. Show toast: “Queued” / “Posted” / error.

Do **not** scrape the DOM for tweet text as the primary data source — use syndication API + X API IDs.

---

## 5. Backend orchestrator (new service)

Can live in **monkeys_engine (Go)** or as **Next.js route handlers** under `apps/the_monkeys/src/app/api/x-automation/`. Prefer Go if we already run workers/cron there; prefer Next if we want to ship faster with shared TS types.

### 5.1 Core modules

```
mention_watcher     → polls X GET /2/users/:id/mentions
orbitor_consumer    → pulls Orbitor feed on schedule
job_queue           → postgres/redis: pending → rendering → posting → done/failed
snapshot_client     → POST render service → PNG bytes
x_client            → media upload + create tweet/reply
moderation          → blocklist, max posts/hour, duplicate tweet IDs
```

### 5.2 Job types

```typescript
type AutomationJobType = 'mention_reply' | 'orbitor_post';

interface AutomationJob {
  id: string;
  type: AutomationJobType;
  sourceTweetId: string;       // tweet to screenshot
  replyToTweetId?: string;     // for mention_reply
  orbitorItemId?: string;      // for orbitor_post
  options: TweetScreenshotOptions;
  status: 'pending' | 'rendering' | 'posting' | 'posted' | 'failed' | 'skipped';
  xReplyTweetId?: string;
  error?: string;
  createdAt: string;
}
```

### 5.3 Mention detection (Workflow A)

**Primary:** X API v2 — `GET /2/users/:id/mentions` with `since_id` cursor.

Requirements:

- X Developer Project with **Elevated** or **Basic** access (confirm tier for mentions + media upload).
- OAuth 2.0 **user context** for `@monkeys` account (PKCE for extension-initiated connect).
- Store refresh token encrypted server-side.

Algorithm:

1. Every 1–2 minutes (worker cron): fetch new mentions.
2. Filter: contains `@monkeys` (case-insensitive), not from self, not already in `processed_mentions` table.
3. Resolve **which tweet to screenshot**:
   - If mention is a reply → screenshot the **parent tweet** or the **mention tweet** (product rule — default: the tweet that contains the tag).
4. Enqueue `mention_reply` job.
5. Render PNG → upload media → `POST /2/tweets` with `reply: { in_reply_to_tweet_id }` and optional short text: *“Here’s your Monkeys snapshot 👇”*.

**Fallback (not recommended for prod):** Extension scrapes X notifications while user is logged in — brittle, breaks on UI changes.

### 5.4 Snapshot render service (blocking prerequisite)

New endpoint (proposed):

```
POST /api/snapshot/tweet/render
Content-Type: application/json

{
  "tweetId": "1234567890",
  "options": { ...TweetScreenshotOptions }
}

→ 200 image/png (1080×1080 or selected aspect)
```

**Implementation options (pick one for v1):**

| Option | Pros | Cons |
|---|---|---|
| **A. Headless Chromium** loads `monkeys.com.co/snapshot/x-render?tweetId=…&options=…` | Pixel-perfect match to UI | Heavy infra, slow |
| **B. Satori** port `ScreenshotCard` to Satori-safe JSX | Fast, cheap, aligns with cast sidecar | Upfront port work; video tweets harder |
| **C. Client upload** extension renders via offscreen doc, uploads PNG to orchestrator | Reuses existing React | Requires browser open; inconsistent |

**Recommendation for v1:** **Option B** for image-only tweets; reuse existing video render route for video tweets. Option A as fallback until Satori parity.

Shared types: import `TweetScreenshotOptions`, `TweetSyndication`, `getTweetCanvasBackground`, `themes.ts` from `@/features/snapshot`.

### 5.5 Posting to X (reply with image)

X API v2 flow:

1. `POST /1.1/media/upload` (or v2 media upload) — PNG bytes.
2. `POST /2/tweets`:
   ```json
   {
     "text": "Your Monkeys snapshot",
     "reply": { "in_reply_to_tweet_id": "<mention_tweet_id>" },
     "media": { "media_ids": ["<id>"] }
   }
   ```

Video tweets: use existing branded MP4 pipeline; X allows video replies with size limits — validate before post.

### 5.6 Rate limits & safety

| Guard | Default |
|---|---|
| Max auto-replies per hour | 10 |
| Max Orbitor posts per day | 6 |
| Cooldown per requesting user | 1 reply / 24h (anti-spam) |
| Blocklist | NSFW accounts, blocked IDs |
| Manual approval mode | On for first 30 days |
| Dry-run mode | Render only, no post |

---

## 6. Orbitor platform integration (Workflow B)

Orbitor is **external to this repo**. Define a contract before implementation.

### 6.1 Assumed Orbitor responsibilities

- Curate tweet URLs/IDs for categories: `business`, `tech`, (optional: `science`, `markets`).
- Score/rank candidates (engagement, recency, editorial fit).
- Expose idempotent feed API so we never repost the same item.

### 6.2 Proposed Orbitor API (to confirm with Orbitor team)

```
GET /v1/feed?category=business|tech&limit=20&cursor=<token>
Authorization: Bearer <service_token>

Response:
{
  "items": [
    {
      "id": "orb_abc123",
      "tweetId": "9876543210",
      "tweetUrl": "https://x.com/user/status/9876543210",
      "category": "tech",
      "title": "Optional headline for reply text",
      "suggestedReplyText": "Worth a read — via @monkeys",
      "priority": 0.82,
      "publishedAt": "2026-06-08T10:00:00Z"
    }
  ],
  "nextCursor": "..."
}
```

Alternative: Orbitor **pushes** to Monkeys webhook:

```
POST https://monkeys.com.co/api/x-automation/orbitor/webhook
X-Orbitor-Signature: sha256=...
{ "item": { ... } }
```

### 6.3 Orbitor job flow

1. Cron every 15–60 minutes: fetch top N items per category.
2. Skip if `orbitor_item_id` already posted.
3. Enqueue `orbitor_post` job → render → new tweet (not reply) with screenshot + suggested text + link to monkeys.com.co.
4. Report outcome back to Orbitor (`POST /v1/items/:id/ack`) for analytics.

### 6.4 Mapping Orbitor categories to screenshot styling

| Category | Default theme | Aspect |
|---|---|---|
| business | `material` or `midnight` | `1200x675` |
| tech | `aurora` or `material-dark` | `1080x1080` |

Stored in orchestrator config, overridable in extension settings.

---

## 7. API surface (Monkeys — new)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/x-automation/connect/x` | Start OAuth; return auth URL |
| `GET` | `/api/x-automation/connect/x/callback` | OAuth callback; store tokens |
| `GET` | `/api/x-automation/jobs` | List queue (extension popup) |
| `POST` | `/api/x-automation/jobs` | Create manual job from extension |
| `POST` | `/api/x-automation/jobs/:id/approve` | Approve pending job |
| `POST` | `/api/snapshot/tweet/render` | **Render PNG (new)** |
| `POST` | `/api/x-automation/orbitor/webhook` | Optional Orbitor push |
| `GET` | `/api/x-automation/health` | Worker + X token status |

Auth: extension sends `Authorization: Bearer <monkeys_user_jwt>` or a dedicated **automation API key** for service accounts.

---

## 8. Data model (minimal)

```sql
-- processed mentions (dedupe)
CREATE TABLE x_processed_mentions (
  tweet_id TEXT PRIMARY KEY,
  mention_tweet_id TEXT NOT NULL,
  job_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- automation jobs
CREATE TABLE x_automation_jobs (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  source_tweet_id TEXT NOT NULL,
  reply_to_tweet_id TEXT,
  orbitor_item_id TEXT UNIQUE,
  options JSONB NOT NULL,
  status TEXT NOT NULL,
  x_post_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- encrypted X OAuth tokens for @monkeys account
CREATE TABLE x_account_tokens (
  account_handle TEXT PRIMARY KEY,
  access_token_enc BYTEA NOT NULL,
  refresh_token_enc BYTEA NOT NULL,
  expires_at TIMESTAMPTZ
);
```

---

## 9. Phased delivery

### Phase 0 — Prerequisites (1 week)

- [ ] X Developer account + app with tweet read/write + media upload scopes.
- [ ] Confirm Orbitor API spec + service token.
- [ ] Legal review: automated replies, attribution, X Automation rules.
- [ ] Decide orchestrator host (Go worker vs Next API routes).

### Phase 1 — Render API + manual extension MVP (2–3 weeks)

- [ ] `POST /api/snapshot/tweet/render` returns PNG for image tweets.
- [ ] Chrome extension: popup + “Screenshot this tweet” on x.com status pages.
- [ ] Manual job → orchestrator renders → user approves → post reply.
- [ ] No auto-mention yet.

**Exit criteria:** User can click one button on a tweet and get a branded reply posted from `@monkeys`.

### Phase 2 — Mention automation (2 weeks)

- [ ] Mention poller worker + dedupe table.
- [ ] Auto-enqueue on `@monkeys` tag.
- [ ] Approval queue in extension (or admin web UI).
- [ ] Toggle: full auto vs approve-first.

**Exit criteria:** Tagging `@monkeys` results in a screenshot reply within SLA (e.g. 5 min).

### Phase 3 — Orbitor curated posts (2 weeks)

- [ ] Orbitor feed consumer + category filters.
- [ ] Scheduled posts with styling presets.
- [ ] Ack/analytics callback to Orbitor.

**Exit criteria:** Business/tech tweets publish on schedule without manual steps.

### Phase 4 — Hardening (ongoing)

- [ ] Video tweet replies via branded MP4.
- [ ] Satori render path (remove Puppeteer dependency).
- [ ] Metrics: render latency, post success rate, mention volume.
- [ ] Admin dashboard for failed jobs and blocklist.

---

## 10. Security & compliance

1. **Never** embed X API client secret in the extension.
2. Encrypt OAuth tokens at rest; rotate refresh tokens.
3. Scope automation API keys per environment (dev/staging/prod).
4. Log all posts with `job_id` for audit.
5. Respect X [Automation rules](https://developer.x.com/en/docs/twitter-api/tweets/manage-tweets/introduction) — disclose automated replies if required.
6. User opt-in: only reply when explicitly tagged; provide opt-out/block mechanism.
7. Content moderation: skip tweets from private/protected accounts (syndication 404).

---

## 11. Open questions (decide before Phase 1)

| # | Question | Options |
|---|---|---|
| 1 | Which tweet gets screenshotted when someone tags `@monkeys` in a reply? | The tagger’s tweet / parent tweet / root thread |
| 2 | Reply copy | Fixed template vs AI-generated vs none (image only) |
| 3 | Full auto or always approve? | Start approve-first |
| 4 | Orbitor API owner & base URL? | TBD |
| 5 | Render v1 engine? | Satori vs headless `/snapshot` page |
| 6 | Handle variants | `@monkeys`, `@monkeys_com_co`, both? |
| 7 | Video mention replies | Phase 1 skip vs branded MP4 |

---

## 12. Success metrics

| Metric | Target (90 days post-launch) |
|---|---|
| Mention → reply latency (p95) | < 5 minutes |
| Render success rate | > 98% |
| Post success rate | > 95% |
| Duplicate reply rate | 0% |
| Orbitor posts / day | 2–6 (configurable) |
| Manual intervention rate | < 10% of jobs |

---

## 13. Related docs & code

- X-Screenshot UI: `apps/the_monkeys/src/features/snapshot/components/SnapshotStudio.tsx`
- Tweet syndication: `apps/the_monkeys/src/app/api/snapshot/tweet/[id]/route.ts`
- Screenshot options: `apps/the_monkeys/src/features/snapshot/types/tweetScreenshotOptions.ts`
- Branded video plan: `apps/the_monkeys/src/features/snapshot/BRANDED_VIDEO_EXPORT_PLAN.md`
- Backend repo: [monkeys_engine](https://github.com/the-monkeys/monkeys_engine)

---

## 14. Next step

Review this plan, resolve **§11 open questions**, and confirm the **Orbitor API contract**. Then proceed with **Phase 0 + Phase 1** (render API + extension MVP with manual post).
