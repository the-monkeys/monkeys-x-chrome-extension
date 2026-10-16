const BUILD_ID = typeof __MONKEYS_BUILD_ID__ === 'string' ? __MONKEYS_BUILD_ID__ : 'development';
function send(message: any) { return chrome.runtime.sendMessage({ ...message, buildId: BUILD_ID }); }
let traceContext: { jobId: string; token: string } | undefined;
function trace(event: string, details: Record<string, unknown> = {}, identity = traceContext) {
  void send({ type: 'AUTOMATION_TRACE', component: 'reply', event, details, ...identity }).catch(() => {});
}
trace('script_ready', { url: location.href });

interface ReplyWork {
  jobId: string;
  token: string;
  tweetId: string;
  account: string;
  caption: string;
  dataUrl: string;
  deadline: number;
}

function delay(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }

function waitFor<T>(find: () => T | null | false, timeout = 20_000): Promise<T | null> {
  return new Promise(resolve => {
    const initial = find();
    if (initial) { resolve(initial); return; }
    const observer = new MutationObserver(() => {
      const result = find();
      if (result) { clearTimeout(timer); observer.disconnect(); resolve(result); }
    });
    const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}

function imageFile(dataUrl: string, filename: string) {
  const bytes = atob(dataUrl.split(',')[1]);
  const data = Uint8Array.from(bytes, char => char.charCodeAt(0));
  return new File([data], filename, { type: dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png' });
}

const EDITORS = '[data-testid="tweetTextarea_0"][contenteditable="true"], [data-testid="tweetTextarea_0"] [contenteditable="true"], .public-DraftEditor-content[contenteditable="true"]';
const UPLOAD = 'input[type="file"][accept*="image"], input[type="file"][data-testid="fileInput"]';
const REPLY = '[data-testid="tweetButtonInline"], [data-testid="tweetButton"]';
let lastEditorCount = 0;

function findEditor() {
  const editors = Array.from(document.querySelectorAll<HTMLElement>(EDITORS))
    .filter(editor => editor.getClientRects().length > 0 && editor.getAttribute('aria-hidden') !== 'true');
  lastEditorCount = editors.length;
  // Never guess between a hidden/global composer and the inline reply.
  return editors.length === 1 ? editors[0] : null;
}

function composerRoot(editor: HTMLElement): HTMLElement | null {
  let parent = editor.parentElement;
  while (parent && parent !== document.body) {
    if (parent.querySelector(UPLOAD) && parent.querySelector(REPLY)) return parent;
    parent = parent.parentElement;
  }
  return null;
}

let running = false;

async function runReplyAutomation() {
  if (running || !/\/status\/\d+/.test(location.pathname)) return;
  running = true; // Set before the first await: messages and SPA mutations can race.
  let work: ReplyWork | undefined;
  let claimed = false;
  let blocked = false;
  try {
    traceContext = undefined;
    work = (await send({ type: 'GET_REPLY_WORK' }))?.work;
    if (!work || Date.now() >= work.deadline) { trace('work_unavailable'); return; }
    traceContext = { jobId: work.jobId, token: work.token };
    trace('work_received', { requestId: work.tweetId, imageCharacters: work.dataUrl.length, imageFormat: work.dataUrl.slice(0, 80).split(',')[0] });
    const profile = await waitFor(() => document.querySelector('a[data-testid="AppTabBar_Profile_Link"]'), 15_000);
    const account = profile?.getAttribute('href')?.replace(/^\//, '').toLowerCase();
    trace('account_checked', { accepted: account === work.account });
    if (account !== work.account) {
      await send({ type: 'AUTOMATION_BLOCKED', payload: {
        jobId: work.jobId, token: work.token, error: 'Sign into @' + work.account + ' on X, then press Start monitoring.',
      } });
      return;
    }
    // The worker persists this claim. Separate script instances, page-ready
    // events and a restarted worker cannot all modify the same draft.
    const compose = await send({ type: 'CLAIM_REPLY_COMPOSE', payload: { jobId: work.jobId, token: work.token } });
    trace('compose_claim_result', { accepted: !!compose?.accepted });
    if (!compose?.accepted) return;
    const editor = await waitFor(findEditor);
    trace('editor_found', { found: !!editor, editorCount: lastEditorCount, editorTextLength: editor?.innerText.length ?? 0 });
    if (!editor) throw new Error('Reply composer unavailable; the request may be deleted or replies restricted.');
    if (editor.innerText.trim()) {
      blocked = true;
      throw new Error('Reply composer contains a draft. Clear it in the reply tab, then press Start monitoring.');
    }
    const root = await waitFor(() => composerRoot(editor));
    trace('composer_controls_found', { found: !!root });
    if (!root) throw new Error('Could not identify the reply composer upload controls.');
    const fileInput = root.querySelector<HTMLInputElement>(UPLOAD);
    if (!fileInput) throw new Error('Image upload input unavailable.');
    const transfer = new DataTransfer();
    transfer.items.add(imageFile(work.dataUrl, 'snapshot_' + work.tweetId + (work.dataUrl.startsWith('data:image/jpeg') ? '.jpg' : '.png')));
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    trace('image_assigned', { fileBytes: transfer.files[0]?.size, fileType: transfer.files[0]?.type, fileName: transfer.files[0]?.name });
    const attachment = await waitFor(() => root.querySelector('[data-testid="attachments"] img, [data-testid="attachments"] [data-testid="tweetPhoto"]'));
    trace('attachment_preview_result', { found: !!attachment });
    if (!attachment) throw new Error('Screenshot attachment did not finish uploading.');
    if (editor.innerText.trim()) {
      blocked = true;
      throw new Error('Reply draft changed during upload. Check the reply tab before resuming monitoring.');
    }
    if (Date.now() >= work.deadline) throw new Error('Reply preparation timed out.');
    editor.click(); editor.focus();
    // insertText acts on the current selection, so bind it to the verified
    // editor explicitly rather than relying on whatever X last focused.
    const range = document.createRange();
    range.selectNodeContents(editor); range.collapse(false);
    const selection = document.getSelection();
    if (!selection) throw new Error('Could not focus the reply editor.');
    selection.removeAllRanges(); selection.addRange(range);
    trace('caption_insert_started', { captionLength: work.caption.length, editorTextLength: editor.innerText.length, active: document.activeElement === editor });
    document.execCommand('insertText', false, work.caption);
    await delay(300);
    trace('caption_insert_result', { accepted: editor.innerText.trim() === work.caption, editorTextLength: editor.innerText.length });
    if (editor.innerText.trim() !== work.caption) {
      blocked = true;
      throw new Error('Could not verify the reply caption. Check the draft before resuming monitoring.');
    }
    const button = await waitFor(() => {
      const candidate = root.querySelector<HTMLButtonElement>(REPLY);
      return candidate && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true' ? candidate : null;
    });
    if (!button || Date.now() >= work.deadline) throw new Error('Reply was not ready before the deadline.');
    trace('reply_button_ready', { found: !!button });
    const previousToasts = new Map(Array.from(document.querySelectorAll('[data-testid="toast"]')).map(el => [el, el.textContent]));
    const claim = await send({ type: 'CLAIM_REPLY', payload: { jobId: work.jobId, token: work.token } });
    if (!claim?.accepted) return;
    claimed = true;
    // Observe before clicking so even an immediate success notification is seen.
    const sent = waitFor(() => Array.from(document.querySelectorAll('[data-testid="toast"]')).find(el =>
      /your (post|reply|tweet) was sent|reply sent/i.test(el.textContent ?? '') &&
      previousToasts.get(el) !== el.textContent
    ), 30_000);
    button.click();
    trace('reply_clicked', { replyClicked: true });
    const confirmed = await sent;
    trace('submission_result', { confirmed: !!confirmed });
    await send({ type: confirmed ? 'REPLY_CONFIRMED' : 'REPLY_UNCERTAIN',
      payload: { jobId: work.jobId, token: work.token } });
  } catch (error) {
    trace('reply_error', { error: error instanceof Error ? error.message : 'Reply failed.' });
    if (work) await send({
      type: claimed ? 'REPLY_UNCERTAIN' : blocked ? 'AUTOMATION_BLOCKED' : 'JOB_FAILED',
      payload: { jobId: work.jobId, token: work.token, error: error instanceof Error ? error.message : 'Reply failed.' },
    }).catch(() => {});
  } finally { running = false; traceContext = undefined; }
}

chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'CHECK_AND_RUN_REPLY') void runReplyAutomation();
});
let lastUrl = location.href;
new MutationObserver(() => {
  if (lastUrl !== location.href) {
    lastUrl = location.href;
    void runReplyAutomation();
  }
}).observe(document.body, { childList: true, subtree: true });
void runReplyAutomation();

export {};
