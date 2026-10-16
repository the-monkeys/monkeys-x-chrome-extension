import { getSettings, ExtensionSettings } from '../lib/storage';
import { configureStudioScripts } from '../lib/studio';
import { BUILD_ID, DIAGNOSTICS_KEY, Diagnostics, ScriptVersion, safeDetails } from './diagnostics';

const STATE_KEY = 'monkeys_automation_state';
const IMAGE_KEY = 'monkeys_reply_image';
const QUEUE_LIMIT = 100;
const LEASE_MS = 3 * 60_000;
const REFRESH_MS = 3 * 60_000;
type Stage = 'queued' | 'rendering' | 'awaiting_approval' | 'reply_ready' | 'posting' | 'retry_wait' | 'needs_review' | 'posted' | 'failed' | 'skipped';
type Role = 'notifications' | 'studio' | 'reply';
interface ManagedTab { id: number; owned: boolean }
export interface AutomationJob {
  id: string;
  tweetId: string;
  tweetUrl: string;
  account: string;
  studioUrl: string;
  stage: Stage;
  attempts: number;
  token?: string;
  deadline?: number;
  retryAt?: number;
  error?: string;
  createdAt: number;
  exportClaimed?: boolean;
  replyDispatched?: boolean;
  composeClaimed?: boolean;
  approved?: boolean;
  reviewTweetId?: string;
  targetKind?: string;
}
interface State {
  version: 1;
  sessionId?: string;
  enabled: boolean;
  jobs: AutomationJob[];
  completed: string[];
  tabs: Partial<Record<Role, ManagedTab>>;
  warning?: string;
  lastCheckAt?: number;
  lastRefreshAt?: number;
}
export interface AutomationStatus {
  buildId: string;
  scriptVersions: ScriptVersion[];
  lastTrace?: string;
  enabled: boolean;
  pendingCount: number;
  queueLimit: number;
  managedTabs: number;
  activeJob?: AutomationJob;
  jobs: AutomationJob[];
  warning?: string;
  lastCheckAt?: number;
}
interface Options {
  settings: () => Promise<ExtensionSettings>;
  configureStudio: (url: string) => Promise<void>;
  now: () => number;
  token: () => string;
  online: () => boolean;
  session: () => Promise<string>;
}
async function browserSession(): Promise<string> {
  const stored = await chrome.storage.session.get('monkeys_browser_session');
  if (stored.monkeys_browser_session) return stored.monkeys_browser_session;
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ monkeys_browser_session: id });
  return id;
}
const terminal = (job: AutomationJob) => ['posted', 'failed', 'skipped'].includes(job.stage);
const xUrl = (url?: string) => {
  try { return !!url && ['https://x.com', 'https://twitter.com'].includes(new URL(url).origin); } catch { return false; }
};

/** All read/modify/write operations and tab creation share this one serial owner.
 * No job relies on the worker's memory surviving between Chrome events. */
export class AutomationController {
  private tail: Promise<unknown> = Promise.resolve();
  private state!: State;
  private power?: boolean;
  private options: Options;
  private session?: Promise<string>;
  private diagnostics: Diagnostics = { events: [], scripts: [] };

  private async record(component: string, event: string, details: unknown = {}, sender?: chrome.runtime.MessageSender, buildId = BUILD_ID, identity?: { jobId?: string; token?: string }) {
    const producer = identity?.jobId ? this.state.jobs.find(job => job.id === identity.jobId) : undefined;
    const job = component === 'background' ? identity?.jobId ? producer : this.active()
      : producer?.token === identity?.token ? producer : undefined;
    const at = this.options.now();
    this.diagnostics.events.push({ at, component, event, buildId, tabId: sender?.tab?.id,
      jobId: job?.id ?? producer?.id, stage: job?.stage, attempt: job?.attempts,
      tokenPrefix: typeof identity?.token === 'string' ? identity.token.slice(0, 12) : undefined,
      stale: producer && component !== 'background' ? producer.token !== identity?.token : undefined, details: safeDetails(details) });
    this.diagnostics.events = this.diagnostics.events.slice(-300);
    if (sender?.tab && component !== 'background') {
      this.diagnostics.scripts = this.diagnostics.scripts.filter(script => script.component !== component || script.tabId !== sender.tab!.id);
      this.diagnostics.scripts.push({ component, buildId, tabId: sender.tab.id, seenAt: at });
      this.diagnostics.scripts = this.diagnostics.scripts.slice(-30);
    }
    await chrome.storage.local.set({ [DIAGNOSTICS_KEY]: this.diagnostics });
  }

  constructor(options: Partial<Options> = {}) {
    this.options = { settings: getSettings, configureStudio: configureStudioScripts, now: Date.now, token: () => crypto.randomUUID(), online: () => typeof navigator === 'undefined' || navigator.onLine !== false, session: browserSession, ...options };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(async () => {
      await this.load();
      try {
        return await operation();
      } catch (error) {
        this.state.warning = `Automation error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400);
        await this.record('background', 'controller_error', { error: this.state.warning }).catch(() => {});
        await this.save().catch(() => {});
        throw error;
      }
    });
    this.tail = result;
    return result;
  }

  private async load() {
    const sessionId = await (this.session ??= this.options.session());
    const stored = await chrome.storage.local.get([STATE_KEY, DIAGNOSTICS_KEY, 'monkeys_processed_mentions', 'monkeys_pending_reply', 'monkeys_pending_snapshot']);
    this.diagnostics = stored[DIAGNOSTICS_KEY] ?? { events: [], scripts: [] };
    if (stored[STATE_KEY]?.version === 1) {
      this.state = stored[STATE_KEY];
      if (this.state.sessionId !== sessionId) {
        // Chrome tab IDs are only meaningful within one browser session. After
        // restart recover by our URL tags, never by an old numeric ID.
        this.state.tabs = {};
        this.state.sessionId = sessionId;
        const job = this.active();
        if (job?.stage === 'posting') {
          job.stage = 'needs_review';
          job.error = 'Browser restarted after reply authorization. Check X before continuing.';
        }
        await this.save();
      }
      return;
    }
    const settings = await this.options.settings();
    this.state = { version: 1, sessionId, enabled: true, jobs: [], completed: (stored.monkeys_processed_mentions ?? []).slice(-1000).map((id: string) => `${settings.xUsername}:${id}`), tabs: {} };
    // Old pending replies have no submission receipt: never replay one blindly.
    const legacy = stored.monkeys_pending_reply;
    if (legacy?.tweetId) {
      this.state.jobs.push({ id: `${settings.xUsername}:${legacy.tweetId}`, tweetId: legacy.tweetId, reviewTweetId: /^\d+$/.test(legacy.targetTweetId ?? '') ? legacy.targetTweetId : legacy.tweetId, tweetUrl: `https://x.com/i/status/${legacy.tweetId}`, account: settings.xUsername, studioUrl: settings.studioUrl, stage: 'needs_review', attempts: 0, createdAt: this.options.now(), error: 'An older reply may have been submitted. Check X, then mark posted or skip.' });
      this.state.warning = 'An older pending reply needs review.';
    } else if (stored.monkeys_pending_snapshot?.tweetId) {
      const pending = stored.monkeys_pending_snapshot;
      this.state.jobs.push({ id: `${settings.xUsername}:${pending.tweetId}`, tweetId: pending.tweetId, tweetUrl: pending.tweetUrl, account: settings.xUsername, studioUrl: settings.studioUrl, stage: 'queued', attempts: 0, createdAt: this.options.now() });
    }
    await this.save();
    await chrome.storage.local.remove(['monkeys_pending_snapshot', 'monkeys_pending_reply']);
  }

  private async save() {
    this.state.jobs = this.state.jobs.filter(job => !terminal(job)).concat(this.state.jobs.filter(terminal).slice(-50));
    this.state.completed = this.state.completed.slice(-1000);
    await chrome.storage.local.set({ [STATE_KEY]: this.state });
  }

  private active() { return this.state.jobs.find(job => !terminal(job)); }
  private status(): AutomationStatus {
    return { buildId: BUILD_ID, scriptVersions: this.diagnostics.scripts, lastTrace: this.diagnostics.events.slice(-1)[0]?.event, enabled: this.state.enabled, pendingCount: this.state.jobs.filter(job => !terminal(job)).length, queueLimit: QUEUE_LIMIT, managedTabs: Object.keys(this.state.tabs).length, activeJob: this.active(), jobs: this.state.jobs.slice(-100), warning: this.state.warning, lastCheckAt: this.state.lastCheckAt };
  }

  private async keepAwake(settings: ExtensionSettings) {
    const awake = this.state.enabled && settings.keepAwake;
    if (this.power === awake) return;
    if (awake) chrome.power.requestKeepAwake('system'); else chrome.power.releaseKeepAwake();
    this.power = awake;
  }

  private async ensureTab(role: Role, url: string, fresh = false): Promise<number> {
    const taggedUrl = new URL(url);
    taggedUrl.hash = `monkeys-automation-${role}`;
    const ownedUrl = taggedUrl.href;
    let managed = this.state.tabs[role];
    let tab: chrome.tabs.Tab | undefined;
    if (managed) {
      try { tab = await chrome.tabs.get(managed.id); } catch { /* closed tab */ }
      if (tab && !managed.owned && (!xUrl(tab.url) || !new URL(tab.url!).pathname.startsWith('/notifications'))) tab = undefined;
    }
    if (!tab) {
      // A worker can stop after tabs.create but before its ID is saved. Recover
      // our tagged tab instead of leaking another tab on every such restart.
      const recovered = (await chrome.tabs.query({}))
        .find(candidate => {
          try {
            const candidateUrl = new URL(candidate.url ?? '');
            return candidateUrl.hash === taggedUrl.hash && (role === 'studio'
              ? ['http:', 'https:'].includes(candidateUrl.protocol) : xUrl(candidate.url));
          } catch { return false; }
        });
      if (recovered?.id !== undefined) { tab = recovered; managed = { id: recovered.id, owned: true }; }
    }
    if (!tab && role === 'notifications') {
      tab = (await chrome.tabs.query({ url: ['https://x.com/notifications*', 'https://twitter.com/notifications*'] }))
        .find(candidate => xUrl(candidate.url) && new URL(candidate.url!).pathname.startsWith('/notifications'));
      if (tab?.id !== undefined) managed = { id: tab.id, owned: false };
    }
    if (!tab) {
      tab = await chrome.tabs.create({ url: ownedUrl, active: false });
      if (tab.id === undefined) throw new Error('Chrome did not return a tab ID.');
      managed = { id: tab.id, owned: true };
      this.state.tabs[role] = managed;
      await this.save();
    } else {
      this.state.tabs[role] = managed!;
      await this.save();
      if (managed!.owned && tab.url !== ownedUrl) await chrome.tabs.update(tab.id!, { url: ownedUrl, active: false });
      else if (managed!.owned && fresh) await chrome.tabs.reload(tab.id!);
    }
    await chrome.tabs.update(tab.id!, { autoDiscardable: false });
    return tab.id!;
  }

  private async signal(id: number, type: string) {
    // A newly created/reloaded tab may not have its script yet. onUpdated and
    // the next alarm will deliver again; creation is never retried here.
    await this.tabMessage(id, type);
  }

  private async tabMessage(id: number, type: string): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A frozen/discarded page may leave its response channel open. Never hold
      // the controller's serial lock indefinitely waiting for a content script.
      return await Promise.race([
        chrome.tabs.sendMessage(id, { type }),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000); }),
      ]);
    } catch { return undefined; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  private async finish(job: AutomationJob, stage: 'posted' | 'failed' | 'skipped') {
    await this.record('background', 'request_finished', { reason: stage, error: job.error ?? '' });
    job.stage = stage;
    job.deadline = undefined;
    this.state.completed.push(job.id);
    if (this.state.warning?.startsWith('Queue full') || this.state.warning?.startsWith('An older pending reply')) this.state.warning = undefined;
    await this.save();
    await chrome.storage.local.remove(IMAGE_KEY);
  }

  private async retry(job: AutomationJob, error: string) {
    await this.record('background', 'retry_scheduled', { error, retryAt: this.options.now() + 60_000 * Math.max(1, job.attempts) });
    job.error = error.slice(0, 300);
    if (job.attempts >= 3) {
      await this.finish(job, 'failed');
      return;
    }
    job.stage = 'retry_wait';
    job.retryAt = this.options.now() + 60_000 * Math.max(1, job.attempts);
    job.deadline = undefined;
    await this.save();
    await chrome.storage.local.remove(IMAGE_KEY);
  }

  private async advance() {
    const settings = await this.options.settings();
    await this.keepAwake(settings);
    if (!this.state.enabled) return;
    if (!this.options.online()) {
      this.state.warning = 'Offline — requests remain saved. Monitoring resumes after reconnection.';
      await this.save(); return;
    }
    if (this.state.warning?.startsWith('Offline') || this.state.warning?.startsWith('Settings changed')) this.state.warning = undefined;
    await this.ensureTab('notifications', 'https://x.com/notifications/mentions');
    const job = this.active();
    if (!job) return;
    if (job.account !== settings.xUsername || job.studioUrl !== settings.studioUrl) {
      this.state.warning = 'Settings changed with unfinished work. Restore the previous account/Studio or skip that request.';
      await this.save();
      return;
    }
    if (job.stage === 'retry_wait' && this.options.now() >= (job.retryAt ?? 0)) job.stage = 'queued';
    if (job.stage === 'queued') {
      job.attempts++;
      job.token = this.options.token();
      job.exportClaimed = false;
      job.replyDispatched = false;
      job.composeClaimed = false;
      job.approved = false;
      job.stage = 'rendering';
      job.retryAt = undefined;
      job.error = undefined;
      job.deadline = this.options.now() + LEASE_MS;
      await this.save();
      try {
        await this.record('background', 'studio_dispatched', { targetUrl: job.tweetUrl, targetKind: job.targetKind ?? 'unknown' });
        await this.options.configureStudio(job.studioUrl);
        const id = await this.ensureTab('studio', `${job.studioUrl}/snapshot/new`, true);
        await this.signal(id, 'PROCESS_PENDING_SNAPSHOT');
      } catch (error) {
        await this.retry(job, error instanceof Error ? error.message : 'Studio could not be opened.');
      }
    } else if (job.stage === 'reply_ready') {
      if (!settings.autoReply && !job.approved) {
        job.stage = 'awaiting_approval';
        await this.save();
        return;
      }
      try {
        await this.record('background', 'reply_dispatched', { requestId: job.tweetId });
        const id = await this.ensureTab('reply', `https://x.com/i/status/${job.tweetId}`, !job.replyDispatched);
        job.replyDispatched = true;
        await this.save();
        await this.signal(id, 'CHECK_AND_RUN_REPLY');
      } catch (error) {
        await this.retry(job, error instanceof Error ? error.message : 'Reply tab could not be opened.');
      }
    }
  }

  private matches(job: AutomationJob | undefined, payload: any, sender: chrome.runtime.MessageSender, role: Role): job is AutomationJob {
    if (!job || job.id !== payload?.jobId || job.token !== payload?.token || sender.tab?.id !== this.state.tabs[role]?.id) return false;
    try {
      const url = new URL(sender.url ?? sender.tab?.url ?? '');
      return role === 'studio' ? url.origin === job.studioUrl && url.pathname.startsWith('/snapshot/') : xUrl(url.href) && url.pathname.match(/\/status\/(\d+)/)?.[1] === job.tweetId;
    } catch { return false; }
  }

  async pulse(browserRestart = false) {
    return this.exclusive(async () => {
      if (!this.options.online()) {
        this.state.lastCheckAt = this.options.now();
        this.state.warning = 'Offline — requests remain saved. Monitoring resumes after reconnection.';
        await this.keepAwake(await this.options.settings());
        await this.save(); return this.status();
      }
      const job = this.active();
      if (job?.stage === 'posting' && (browserRestart || this.options.now() >= (job.deadline ?? 0))) {
        job.stage = 'needs_review';
        job.error = 'Reply may have been sent. Check X before marking posted or skipping; automatic resubmission is blocked.';
      } else if (this.state.enabled && job && ['rendering', 'reply_ready'].includes(job.stage) && this.options.now() >= (job.deadline ?? 0)) {
        await this.retry(job, job.stage === 'rendering' && job.exportClaimed
          ? 'Studio image export did not finish before its deadline. Check bridge/export progress in Diagnostics.'
          : 'The Studio or reply step did not finish before its deadline. See Diagnostics for the last completed step.');
      }
      this.state.lastCheckAt = this.options.now();
      await this.save();
      await this.advance();
      if (this.state.enabled && this.state.tabs.notifications) {
        const id = this.state.tabs.notifications.id;
        const health = await this.tabMessage(id, 'SCAN_NOTIFICATIONS');
        if (health?.loggedIn === false) {
          this.state.enabled = false;
          this.state.warning = 'Log into the configured X account, then press Start monitoring.';
          await this.keepAwake(await this.options.settings());
        } else if (this.status().pendingCount < QUEUE_LIMIT && (!this.state.lastRefreshAt || this.options.now() - this.state.lastRefreshAt >= REFRESH_MS)) {
          this.state.lastRefreshAt = this.options.now();
          await this.save();
          await chrome.tabs.reload(id);
        }
        await this.save();
      }
      return this.status();
    });
  }

  async tabReady(tabId: number) {
    return this.exclusive(async () => {
      if (!this.state.enabled) return;
      const job = this.active();
      if (job?.stage === 'rendering' && tabId === this.state.tabs.studio?.id) await this.signal(tabId, 'PROCESS_PENDING_SNAPSHOT');
      if (job?.stage === 'reply_ready' && tabId === this.state.tabs.reply?.id) await this.signal(tabId, 'CHECK_AND_RUN_REPLY');
    });
  }

  async tabRemoved(tabId: number) {
    return this.exclusive(async () => {
      for (const role of ['notifications', 'studio', 'reply'] as Role[]) {
        if (this.state.tabs[role]?.id !== tabId) continue;
        delete this.state.tabs[role];
        const job = this.active();
        if (job && role === 'reply' && job.stage === 'posting') {
          job.stage = 'needs_review'; job.error = 'Reply tab closed after submission authorization. Check X before continuing.';
        } else if (job && ((role === 'studio' && job.stage === 'rendering') || (role === 'reply' && job.stage === 'reply_ready'))) {
          await this.retry(job, 'Managed tab closed before completion.');
        }
      }
      await this.save();
    });
  }

  async handle(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
    return this.exclusive(async () => {
      if (message.type === 'GET_AUTOMATION_STATUS') return this.status();
      if (message.type === 'GET_DIAGNOSTICS') {
        if (sender.tab) return { accepted: false };
        const settings = await this.options.settings();
        const image = (await chrome.storage.local.get(IMAGE_KEY))[IMAGE_KEY];
        return { version: 1, buildId: BUILD_ID, exportedAt: this.options.now(), enabled: this.state.enabled,
          lastCheckAt: this.state.lastCheckAt, managedTabs: this.state.tabs,
          settings: { xUsername: settings.xUsername, studioUrl: settings.studioUrl, autoReply: settings.autoReply, keepAwake: settings.keepAwake },
          jobs: this.state.jobs.map(job => ({ id: job.id, requestId: job.tweetId, targetUrl: job.tweetUrl,
            targetKind: job.targetKind, stage: job.stage, attempts: job.attempts, error: safeDetails({ error: job.error }).error })),
          image: image ? { jobId: image.jobId, characters: image.dataUrl?.length,
            format: typeof image.dataUrl === 'string' && /^data:image\/(png|jpeg);base64,/.test(image.dataUrl) ? image.dataUrl.slice(0, 40).split(',')[0] : 'unknown' } : null,
          events: this.diagnostics.events, scripts: this.diagnostics.scripts };
      }
      if (message.type === 'AUTOMATION_TRACE') {
        if (!['watcher', 'studio', 'reply'].includes(message.component) || !/^[a-z_]{1,60}$/.test(message.event)) return { accepted: false };
        const settings = await this.options.settings();
        let allowed = false;
        try {
          const url = new URL(sender.url ?? sender.tab?.url ?? '');
          allowed = message.component === 'studio' ? url.origin === settings.studioUrl && url.pathname.startsWith('/snapshot/') : xUrl(url.href);
        } catch { /* invalid sender */ }
        if (!allowed || !sender.tab) return { accepted: false };
        await this.record(message.component, message.event, message.details, sender, typeof message.buildId === 'string' ? message.buildId.slice(0, 80) : 'unknown',
          { jobId: typeof message.jobId === 'string' ? message.jobId.slice(0, 80) : undefined, token: typeof message.token === 'string' ? message.token.slice(0, 80) : undefined });
        return { accepted: true };
      }
      if (message.type === 'MENTION_DETECTED') {
        if (!xUrl(sender.url ?? sender.tab?.url)) return { accepted: false };
        const settings = await this.options.settings();
        const payload = message.payload;
        if (payload?.account && payload.account !== settings.xUsername) return { accepted: false, reason: 'account_changed' };
        if (!/^\d+$/.test(payload?.tweetId ?? '') || !xUrl(payload?.tweetUrl) || new URL(payload.tweetUrl).pathname.match(/\/status\/(\d+)/)?.[1] === undefined) return { accepted: false };
        const id = `${settings.xUsername}:${payload.tweetId}`;
        if (this.state.jobs.some(job => job.id === id) || this.state.completed.includes(id)) return { accepted: true, duplicate: true };
        if (!this.state.enabled) return { accepted: false, reason: 'paused' };
        if (this.status().pendingCount >= QUEUE_LIMIT) {
          this.state.warning = 'Queue full (100 requests). New requests have not been accepted; retry after capacity is available.';
          await this.save(); return { accepted: false, reason: 'full' };
        }
        this.state.jobs.push({ id, tweetId: payload.tweetId, tweetUrl: payload.tweetUrl, targetKind: ['current', 'parent', 'url'].includes(payload.targetKind) ? payload.targetKind : 'unknown', account: settings.xUsername, studioUrl: settings.studioUrl, stage: 'queued', attempts: 0, createdAt: this.options.now() });
        await this.save(); // Acknowledge only after durable admission.
        await this.record('background', 'request_queued', { requestId: payload.tweetId, targetUrl: payload.tweetUrl, targetKind: payload.targetKind ?? 'unknown', requestTextLength: payload.requestTextLength }, undefined, BUILD_ID, { jobId: id });
        const recent = this.state.jobs.slice(-50).reverse().map(job => ({ tweetId: job.tweetId, detectedAt: new Date(job.createdAt).toISOString() }));
        await chrome.storage.local.set({ monkeys_recent_mentions: recent });
        await this.advance();
        return { accepted: true };
      }
      const job = this.active();
      const studioMessages = ['GET_SNAPSHOT_WORK', 'CLAIM_SNAPSHOT_EXPORT', 'SNAPSHOT_DOWNLOADED'];
      const replyMessages = ['GET_REPLY_WORK', 'CLAIM_REPLY_COMPOSE', 'CLAIM_REPLY'];
      if (job && (studioMessages.includes(message.type) || replyMessages.includes(message.type))) {
        const role = studioMessages.includes(message.type) ? 'studio' : 'reply';
        if (this.matches(job, { jobId: message.payload?.jobId ?? job.id, token: message.payload?.token ?? job.token }, sender, role)) {
          await this.record(role, 'work_message', { messageType: message.type }, sender, typeof message.buildId === 'string' ? message.buildId.slice(0, 80) : 'unknown',
            { jobId: message.payload?.jobId ?? job.id, token: message.payload?.token ?? job.token });
          if (message.buildId !== BUILD_ID) {
            this.state.warning = `Old ${role} script detected. Reload the extension, then refresh the X and Studio tabs.`;
            await this.save();
            await this.record('background', 'stale_script_blocked', { role, messageType: message.type });
            return { accepted: false, work: null, reason: 'reload_required' };
          }
        }
      }
      if (message.type === 'AUTOMATION_CONTROL') {
        // Only extension UI can resolve uncertain posts or authorize manual work.
        if (sender.tab) return { accepted: false };
        if (!['pause', 'start'].includes(message.action) && (!job || message.jobId !== job.id)) return { accepted: false };
        if (message.action === 'pause') this.state.enabled = false;
        else if (message.action === 'start') {
          if (!this.state.enabled && job?.stage === 'reply_ready') job.deadline = this.options.now() + LEASE_MS;
          this.state.enabled = true; this.state.warning = undefined;
        }
        else if (message.action === 'approve' && job?.stage === 'awaiting_approval') { job.stage = 'reply_ready'; job.approved = true; job.deadline = this.options.now() + LEASE_MS; }
        else if (message.action === 'resolve_posted' && job?.stage === 'needs_review') await this.finish(job, 'posted');
        else if (message.action === 'skip' && job && job.stage !== 'posting') await this.finish(job, 'skipped');
        else return { accepted: false };
        await this.record('background', 'user_control', { reason: message.action });
        await this.save(); await this.advance(); return { accepted: true, status: this.status() };
      }
      if (message.type === 'GET_SNAPSHOT_WORK') {
        if (!this.state.enabled || job?.stage !== 'rendering' || !this.matches(job, { jobId: job.id, token: job.token }, sender, 'studio') || this.options.now() >= (job.deadline ?? 0)) return { work: null };
        return { work: { jobId: job.id, token: job.token, tweetId: job.tweetId, tweetUrl: job.tweetUrl, studioOrigin: job.studioUrl, deadline: job.deadline } };
      }
      const payload = message.payload;
      if (message.type === 'CLAIM_SNAPSHOT_EXPORT') {
        if (!this.state.enabled || job?.stage !== 'rendering' || job.exportClaimed || !this.matches(job, payload, sender, 'studio') || this.options.now() >= (job.deadline ?? 0)) return { accepted: false };
        await this.record('background', 'export_claimed');
        job.exportClaimed = true; await this.save(); return { accepted: true };
      }
      if (message.type === 'SNAPSHOT_DOWNLOADED') {
        if (job?.stage !== 'rendering' || !this.matches(job, payload, sender, 'studio') || this.options.now() >= (job.deadline ?? 0)) return { accepted: false };
        const image = payload.dataUrl;
        await this.record('background', 'image_received', { imageCharacters: typeof image === 'string' ? image.length : 0,
          imageFormat: typeof image === 'string' && image.startsWith('data:') ? image.slice(0, 80).split(',')[0] : 'unknown' });
        const imageError = typeof image !== 'string' ? 'Studio did not return image data.'
          : image.length > 6_000_000 ? `Screenshot transfer is too large (${(image.length / 1_000_000).toFixed(1)} MB; limit 6 MB). Reload the extension and Studio to enable compression.`
          : !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image) ? `Unsupported Studio image data (${image.startsWith('data:') ? image.slice(0, 80).split(',')[0] : 'missing image data URL'}).`
          : null;
        if (imageError) {
          await this.retry(job, imageError); return { accepted: false };
        }
        await chrome.storage.local.set({ [IMAGE_KEY]: { jobId: job.id, token: job.token, dataUrl: payload.dataUrl } });
        job.stage = (await this.options.settings()).autoReply ? 'reply_ready' : 'awaiting_approval';
        job.deadline = this.options.now() + LEASE_MS;
        await this.record('background', 'image_saved', { reason: job.stage });
        await this.save(); await this.advance(); return { accepted: true };
      }
      if (message.type === 'GET_REPLY_WORK') {
        if (!this.state.enabled || job?.stage !== 'reply_ready' || !this.matches(job, { jobId: job.id, token: job.token }, sender, 'reply') || this.options.now() >= (job.deadline ?? 0)) return { work: null };
        const image = (await chrome.storage.local.get(IMAGE_KEY))[IMAGE_KEY];
        if (image?.jobId !== job.id || image?.token !== job.token) { await this.retry(job, 'Screenshot data missing after interruption.'); return { work: null }; }
        return { work: { ...image, tweetId: job.tweetId, account: job.account, caption: 'Here is your Monkeys snapshot.', deadline: job.deadline } };
      }
      if (message.type === 'CLAIM_REPLY_COMPOSE' || message.type === 'CLAIM_REPLY') {
        const settings = await this.options.settings();
        if (!this.state.enabled || job?.stage !== 'reply_ready' || (!settings.autoReply && !job.approved) || settings.xUsername !== job.account || settings.studioUrl !== job.studioUrl || !this.matches(job, payload, sender, 'reply') || this.options.now() >= (job.deadline ?? 0)) return { accepted: false };
        if (message.type === 'CLAIM_REPLY_COMPOSE') {
          if (job.composeClaimed) return { accepted: false };
          await this.record('background', 'compose_claimed');
          job.composeClaimed = true;
          await this.save(); return { accepted: true };
        }
        job.stage = 'posting'; job.deadline = this.options.now() + LEASE_MS;
        await this.record('background', 'post_authorized');
        await this.save(); return { accepted: true }; // Persist before allowing the click.
      }
      if (message.type === 'REPLY_CONFIRMED' || message.type === 'REPLY_UNCERTAIN') {
        if (!job || !['posting', 'needs_review'].includes(job.stage) || !this.matches(job, payload, sender, 'reply')) return { accepted: false };
        await this.record('background', 'post_result', { confirmed: message.type === 'REPLY_CONFIRMED' });
        if (message.type === 'REPLY_CONFIRMED') { await this.finish(job, 'posted'); await this.advance(); }
        else { job.stage = 'needs_review'; job.error = 'No submission confirmation. Check X, then mark posted or skip; automatic resubmission is blocked.'; await this.save(); }
        return { accepted: true };
      }
      if (message.type === 'JOB_FAILED' || message.type === 'AUTOMATION_BLOCKED') {
        const role = job?.stage === 'rendering' ? 'studio' : 'reply';
        if (!job || !['rendering', 'reply_ready'].includes(job.stage) || !this.matches(job, payload, sender, role)) return { accepted: false };
        await this.record('background', 'script_failed', { role, error: String(payload.error) });
        if (message.type === 'AUTOMATION_BLOCKED') {
          this.state.enabled = false; this.state.warning = String(payload.error).slice(0, 300);
          // A blocked script has stopped before authorizing a post. After the
          // user fixes the draft/account and presses Start, reload the managed
          // reply tab and allow a new preparation claim.
          if (job.stage === 'reply_ready') { job.composeClaimed = false; job.replyDispatched = false; }
          await this.keepAwake(await this.options.settings()); await this.save();
        } else await this.retry(job, String(payload.error));
        return { accepted: true };
      }
      return { accepted: false };
    });
  }
}
