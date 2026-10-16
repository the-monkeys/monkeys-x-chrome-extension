const BUILD_ID = typeof __MONKEYS_BUILD_ID__ === 'string' ? __MONKEYS_BUILD_ID__ : 'development';
function send(message: any) { return chrome.runtime.sendMessage({ ...message, buildId: BUILD_ID }); }
let traceContext: { jobId: string; token: string } | undefined;
function trace(event: string, details: Record<string, unknown> = {}, identity = traceContext) {
  void send({ type: 'AUTOMATION_TRACE', component: 'watcher', event, details, ...identity }).catch(() => {});
}
trace('script_ready', { url: location.href });

// This helper is used only here and is bundled into the classic content script.
import { canonicalPostUrl, parseScreenshotRequest, resolveScreenshotRequest } from '../lib/screenshot-request';
let xUsername: string | null = null;
let seen = new WeakMap<Element, string>();
let unresolved = new WeakMap<Element, string>();
let scanning = false;
let scanAgain = false;
let backpressure = false;
let lastDomChangeAt = Date.now();
let lastScanAt = 0;

function getTweetInfo(el: Element) {
  // A timestamp permalink identifies the request. Never fall back to a photo,
  // quoted tweet, or the first arbitrary status link in a notification.
  const ownTime = Array.from(el.querySelectorAll('time')).find(time => {
    if (time.closest('article') !== el || time.closest('[data-testid="quoteTweet"]')) return false;
    const permalink = time.closest('a[href*="/status/"]');
    // The permalink itself can have role="link". Only a containing card/link
    // outside that permalink indicates a quoted post.
    return !!permalink && !permalink.parentElement?.closest('[data-testid="quoteTweet"], [role="link"]');
  });
  const timestamp = ownTime?.closest('a[href*="/status/"]');
  const href = timestamp?.getAttribute('href');
  const tweetUrl = href && canonicalPostUrl(new URL(href, 'https://x.com').href);
  if (!tweetUrl) return null;
  const tweetId = tweetUrl.match(/\/status\/(\d+)$/)![1];
  // Relationship metadata is evidence; link order or visual adjacency is not.
  // Without it, "above" is deliberately unresolved and ignored.
  const parentId = el.getAttribute('data-in-reply-to-status-id') ?? undefined;
  return { tweetId, tweetUrl, parentId };
}

function requestText(article: Element): string | null {
  const ownText = Array.from(article.querySelectorAll('[data-testid="tweetText"]'))
    .find(node => !node.closest('[data-testid="quoteTweet"], [role="link"]'));
  if (!ownText) return null;
  const copy = ownText.cloneNode(true) as Element;
  for (const link of copy.querySelectorAll('a')) {
    for (const attribute of ['data-expanded-url', 'title', 'href']) {
      let value = link.getAttribute(attribute) ?? '';
      if (/^(?:x|twitter)\.com\//i.test(value)) value = `https://${value}`;
      const expanded = canonicalPostUrl(value);
      if (expanded) { link.textContent = expanded; break; }
    }
  }
  return copy.textContent;
}

async function processNotifications() {
  if (!xUsername || backpressure || !location.pathname.startsWith('/notifications')) return;
  if (scanning) { scanAgain = true; return; }
  scanning = true;
  const account = xUsername;
  try {
    for (const article of document.querySelectorAll('article')) {
      if (account !== xUsername || backpressure) break;
      const text = requestText(article);
      if (!text) continue;
      const signature = account + ':' + text;
      if (seen.get(article) === signature) continue;
      const request = parseScreenshotRequest(text, account);
      if (!request) continue;
      const info = getTweetInfo(article);
      if (!info) continue;
      const targetUrl = resolveScreenshotRequest(request, { currentUrl: info.tweetUrl, parentId: info.parentId });
      if (!targetUrl) {
        if (unresolved.get(article) !== signature) trace('target_unresolved', { requestId: info.tweetId, targetKind: request.target, reason: 'Parent relationship not verified' });
        unresolved.set(article, signature);
        continue;
      }
      try {
        const response = await send({ type: 'MENTION_DETECTED', payload: {
          tweetId: info.tweetId, tweetUrl: targetUrl, targetKind: request.target, requestTextLength: text.length, detectedAt: new Date().toISOString(), account,
        } });
        if (response?.accepted) seen.set(article, signature);
        else if (response?.reason === 'full' || response?.reason === 'paused') backpressure = true;
      } catch {
        // Without an acknowledgement, leave this request eligible for a health scan.
      }
    }
    lastScanAt = Date.now();
  } finally {
    scanning = false;
    if (scanAgain) { scanAgain = false; queueMicrotask(() => { void processNotifications(); }); }
  }
}

new MutationObserver(() => {
  lastDomChangeAt = Date.now();
  void processNotifications();
}).observe(document.body, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'SCAN_NOTIFICATIONS') return;
  const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
  const login = document.querySelector('a[href="/login"]');
  // Reply before scanning: the coordinator holds its queue lock during this ping.
  sendResponse({ buildId: BUILD_ID, ready: !!xUsername && location.pathname.startsWith('/notifications'), scannedAt: lastScanAt, lastDomChangeAt,
    loggedIn: profile ? profile.replace(/^\//, '').toLowerCase() === xUsername : login ? false : undefined });
  backpressure = false;
  void processNotifications();
});

const updateUsername = (value: string) => {
  const normalized = value.trim().replace(/^@/, '').toLowerCase();
  xUsername = /^[a-z0-9_]{1,15}$/.test(normalized) ? normalized : null;
  seen = new WeakMap(); unresolved = new WeakMap(); backpressure = false;
  void processNotifications();
};
let settingsChanged = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.xUsername) {
    settingsChanged = true;
    updateUsername(changes.xUsername.newValue ?? 'monkeys_com_co');
  }
});
void chrome.storage.sync.get({ xUsername: 'monkeys_com_co' }).then(settings => {
  if (!settingsChanged) updateUsername(settings.xUsername);
}).catch(error => console.error('[Monkeys] Could not load X username:', error));
