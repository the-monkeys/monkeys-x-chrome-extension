const BUILD_ID = typeof __MONKEYS_BUILD_ID__ === 'string' ? __MONKEYS_BUILD_ID__ : 'development';
function send(message: any) { return chrome.runtime.sendMessage({ ...message, buildId: BUILD_ID }); }
let traceContext: { jobId: string; token: string } | undefined;
function trace(event: string, details: Record<string, unknown> = {}, identity = traceContext) {
  void send({ type: 'AUTOMATION_TRACE', component: 'studio', event, details, ...identity }).catch(() => {});
}
trace('script_ready', { url: location.href });

/**
 * Snapshot Automator - Content script for the configured Studio /snapshot/*
 *
 * Sets the Tweet URL, selects Midnight and Portrait (4:5), and exports the image.
 */

interface PendingSnapshot {
  jobId: string;
  token: string;
  tweetId: string;
  tweetUrl: string;
  studioOrigin: string;
  deadline: number;
}

async function getPendingSnapshot(): Promise<PendingSnapshot | null> {
  try {
    const result = await send({ type: 'GET_SNAPSHOT_WORK' });
    return result?.work ?? null;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input), 'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Set native select value for Aspect Ratio */
function selectAspectRatio(): boolean {
  const selects = document.querySelectorAll('select');
  for (const select of selects) {
    for (let i = 0; i < select.options.length; i++) {
      const opt = select.options[i];
      if (opt.text.includes('4:5') || opt.value.includes('4:5') || opt.text.includes('Portrait')) {
        const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(select, opt.value);
        } else {
          select.value = opt.value;
        }
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('[Monkeys] Native select changed to:', opt.text);
        return true;
      }
    }
  }
  return false;
}

/** Download produces a blob without requiring clipboard focus or permission. */
function getDownloadButton(): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => /^download(?: png)?$/i.test(button.textContent?.trim() ?? '')) ?? null;
}

function verifyBridge(token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'MONKEYS_BRIDGE_READY' || event.data.token !== token) return;
      if (event.data.version !== '2') return;
      clearTimeout(timer); window.removeEventListener('message', listener);
      trace('bridge_ready', { bridgeVersion: event.data.version }); resolve();
    };
    const timer = setTimeout(() => {
      window.removeEventListener('message', listener);
      reject(new Error('Studio export bridge unavailable. Refresh the Studio tab after reloading the extension.'));
    }, 5000);
    window.addEventListener('message', listener);
    window.postMessage({ type: 'MONKEYS_BRIDGE_PING', token }, '*');
  });
}

function waitForExportReady(deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => {
      const button = getDownloadButton();
      const preview = document.querySelector('section')?.textContent ?? '';
      const previewContent = preview.split(/x[- ]screenshot/i)[1] ?? '';
      return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
        /x[- ]screenshot/i.test(preview) && !/^\s*(?:loading post|paste an x post url)/i.test(previewContent);
    };
    if (ready()) { resolve(); return; }
    const observer = new MutationObserver(() => {
      if (ready()) { observer.disconnect(); clearTimeout(timer); resolve(); }
    });
    const timer = setTimeout(() => {
      observer.disconnect(); reject(new Error('Studio did not finish loading the requested post preview, or image download is unavailable.'));
    }, Math.max(0, deadline - Date.now()));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

// The background registers the blob interceptor directly in the page's MAIN world.

/** Robustly find the tweet URL input element with retries and multiple fallback selectors */
async function findTweetUrlInput(): Promise<HTMLInputElement | HTMLTextAreaElement | null> {
  const selectors = [
    'input#snap-tweet-url',
    'input[placeholder*="x.com"]',
    'input[placeholder*="status"]',
    'input[placeholder*="http"]',
    'input[type="url"]',
    'textarea[placeholder*="x.com"]',
    'textarea',
    'input[type="text"]',
    'input'
  ];

  for (let attempt = 0; attempt < 30; attempt++) {
    const postToggle = Array.from(document.querySelectorAll('button[aria-expanded]'))
      .find(button => button.textContent?.trim().toLowerCase() === 'x post');
    if (postToggle?.getAttribute('aria-expanded') === 'false') {
      (postToggle as HTMLElement).click();
    }

    for (const selector of selectors) {
      const els = Array.from(document.querySelectorAll(selector));
      for (const el of els) {
        if ((el as HTMLElement).offsetParent !== null && !(el as HTMLInputElement).disabled) {
          return el as HTMLInputElement | HTMLTextAreaElement;
        }
      }
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue?.trim().toLowerCase() || '';
      if (text.includes('tweet url') || text.includes('x.com') || text.includes('post url') || text.includes('paste')) {
        const input = node.parentElement?.closest('label')?.querySelector('input, textarea') ||
          node.parentElement?.parentElement?.querySelector('input, textarea');
        if (input && (input as HTMLElement).offsetParent !== null) {
          return input as HTMLInputElement | HTMLTextAreaElement;
        }
      }
    }

    await delay(500);
  }
  return null;
}

let currentPending: PendingSnapshot | null = null;
let metadataWork: PendingSnapshot | null = null;
let running = false;
let attemptedToken: string | undefined;
let exportTimer: ReturnType<typeof setTimeout> | undefined;

// Listen for intercepted blob from the injected script
window.addEventListener('message', (event) => {
  if (event.source === window && event.data?.type === 'MONKEYS_EXPORT_PROGRESS' && metadataWork && metadataWork.token === event.data.token) {
    trace('export_progress', { reason: event.data.event, fileBytes: event.data.bytes, imageFormat: event.data.imageFormat, visibilityState: event.data.visibilityState }, metadataWork);
    return;
  }
  if (event.source === window && event.data?.type === 'MONKEYS_STUDIO_POST_METADATA' && metadataWork && metadataWork.token === event.data.token) {
    const { targetId, sourcePostId, responseStatus, textLength, mentionCount, leadingMentionCount, displayTextStart } = event.data;
    trace('studio_post_metadata', { targetId, sourcePostId, responseStatus, textLength, mentionCount, leadingMentionCount, displayTextStart }, metadataWork);
    return;
  }
  if (event.source !== window || !['MONKEYS_INTERCEPTED_BLOB', 'MONKEYS_EXPORT_FAILED'].includes(event.data?.type)) return;
  if (!currentPending || event.data.token !== currentPending.token) return;

  const failed = event.data.type === 'MONKEYS_EXPORT_FAILED';
  if (exportTimer !== undefined) clearTimeout(exportTimer);
  trace('export_received', { accepted: !failed, imageCharacters: event.data.dataUrl?.length, error: failed ? String(event.data.error) : '' }, currentPending);
  console.log('[Monkeys] Studio export result:', failed ? event.data.error : {
    format: String(event.data.dataUrl).slice(0, 40).split(',')[0], characters: event.data.dataUrl?.length,
  });
  send({
    type: failed ? 'JOB_FAILED' : 'SNAPSHOT_DOWNLOADED',
    payload: {
      jobId: currentPending.jobId,
      token: currentPending.token,
      ...(failed ? { error: String(event.data.error).slice(0, 300) } : { dataUrl: event.data.dataUrl })
    }
  }).catch(() => { });
  document.documentElement.removeAttribute('data-monkeys-export-until');
  document.documentElement.removeAttribute('data-monkeys-export-token');
  document.documentElement.removeAttribute('data-monkeys-job-token');
  metadataWork = null;
  currentPending = null;
});

async function run(): Promise<void> {
  if (running) return;
  running = true;
  let pending: PendingSnapshot | null = null;
  try {
    pending = await getPendingSnapshot();
    if (!pending) {
      console.log('[Monkeys] No pending snapshot — page opened manually.');
      return;
    }
    if (pending.studioOrigin !== location.origin) return;
    if (pending.token === attemptedToken || Date.now() >= pending.deadline) return;
    attemptedToken = pending.token;
    traceContext = { jobId: pending.jobId, token: pending.token };
    metadataWork = pending;
    document.documentElement.setAttribute('data-monkeys-job-token', pending.token);
    trace('work_received', { requestId: pending.tweetId, targetUrl: pending.tweetUrl });
    await verifyBridge(pending.token);

    currentPending = null;
    document.documentElement.removeAttribute('data-monkeys-export-until');
    document.documentElement.removeAttribute('data-monkeys-export-token');

    console.log('[Monkeys] Pending snapshot found:', pending.tweetId, pending.tweetUrl);

    const titleHeader = document.querySelector('h1, h2');
    if (titleHeader) (titleHeader as HTMLElement).click();

    const tabButtons = document.querySelectorAll('button[role="tab"]');
    for (const tab of tabButtons) {
      if (tab.textContent?.trim().toLowerCase().includes('x screenshot')) {
        const isActive = tab.getAttribute('aria-selected') === 'true' || tab.getAttribute('data-state') === 'active';
        if (!isActive) {
          (tab as HTMLElement).click();
          console.log('[Monkeys] Clicked "X screenshot" tab');
          await delay(500);
        }
        break;
      }
    }

    const urlInput = await findTweetUrlInput();
    if (!urlInput) {
      throw new Error('Studio URL input unavailable.');
    }

    urlInput.focus();
    setInputValue(urlInput, pending.tweetUrl);
    trace('url_input_filled', { inputUrl: urlInput.value, targetUrl: pending.tweetUrl });
    console.log('[Monkeys] Tweet URL filled successfully:', pending.tweetUrl);

    // Let the input update enter React, then observe real export readiness rather
    // than assuming a fixed network/rendering time in a throttled background tab.
    await delay(100);
    await waitForExportReady(pending.deadline);

    // Open the style section only when collapsed, so an already visible theme stays accessible.
    const styleToggle = Array.from(document.querySelectorAll('button[aria-expanded]'))
      .find(button => button.textContent?.trim().toLowerCase() === 'screenshot style');
    if (styleToggle?.getAttribute('aria-expanded') === 'false') {
      (styleToggle as HTMLElement).click();
      await delay(500);
    }
    const midnight = Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent?.trim().toLowerCase() === 'midnight');
    if (!midnight) {
      throw new Error('Midnight theme unavailable; export stopped.');
    }
    midnight.click();
    trace('theme_selected', { selectedTheme: 'midnight' });
    console.log('[Monkeys] Selected Midnight theme');

    await delay(100);

    const setAspect = selectAspectRatio();
    if (!setAspect) {
      console.warn('[Monkeys] Could not find or set Aspect Ratio select');
    }

    await delay(100);
    await waitForExportReady(pending.deadline);

    // Only accept image blobs produced after Midnight has been selected.
    const claim = await send({ type: 'CLAIM_SNAPSHOT_EXPORT', payload: { jobId: pending.jobId, token: pending.token } });
    if (!claim?.accepted || Date.now() >= pending.deadline) return;
    trace('export_claim_result', { accepted: true });
    currentPending = pending;
    document.documentElement.setAttribute('data-monkeys-export-until', String(pending.deadline));
    document.documentElement.setAttribute('data-monkeys-export-token', pending.token);
    const download = getDownloadButton();
    if (!download || download.disabled) throw new Error('Studio image download unavailable.');
    const exporting = pending;
    exportTimer = setTimeout(() => {
      if (currentPending?.token !== exporting.token) return;
      trace('studio_error', { error: 'Studio Download did not return an image within 60 seconds.' }, exporting);
      void send({ type: 'JOB_FAILED', payload: { jobId: exporting.jobId, token: exporting.token,
        error: 'Studio Download did not return an image within 60 seconds. See export progress in Diagnostics.' } }).catch(() => {});
      document.documentElement.removeAttribute('data-monkeys-export-until');
      document.documentElement.removeAttribute('data-monkeys-export-token');
      document.documentElement.removeAttribute('data-monkeys-job-token');
      currentPending = null; metadataWork = null;
    }, Math.min(60_000, Math.max(0, pending.deadline - Date.now())));
    download.click();
    trace('export_clicked', { reason: 'download', visibilityState: document.visibilityState });
  } catch (error) {
    if (exportTimer !== undefined) clearTimeout(exportTimer);
    trace('studio_error', { error: error instanceof Error ? error.message : 'Screenshot failed.' });
    document.documentElement.removeAttribute('data-monkeys-export-until');
    document.documentElement.removeAttribute('data-monkeys-export-token');
    document.documentElement.removeAttribute('data-monkeys-job-token');
    metadataWork = null;
    currentPending = null;
    if (pending) await send({ type: 'JOB_FAILED', payload: {
      jobId: pending.jobId, token: pending.token, error: error instanceof Error ? error.message : 'Screenshot failed.',
    } }).catch(() => {});
  } finally { running = false; traceContext = undefined; }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROCESS_PENDING_SNAPSHOT') {
    console.log('[Monkeys] Received PROCESS_PENDING_SNAPSHOT message, running automation...');
    run();
  }
});

setTimeout(run, 2000);

export { };
