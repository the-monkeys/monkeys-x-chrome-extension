import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './harness.mjs';

function replyEnvironment({ allowed = true, success = true, account = 'monkeys_com_co', withoutForm = false,
  uploadReady = true, draft = '', composeAllowed = true, dataUrl = 'data:image/png;base64,YQ==' } = {}) {
  const messages = [];
  const observers = new Set();
  const timers = new Map();
  let onMessage;
  let clicked = 0;
  let toasts = [];
  const actions = [];
  const uploads = [];
  const editor = { innerText: draft, click() {}, focus() {}, getClientRects: () => [{}],
    closest: selector => selector === 'form' && !withoutForm ? root : null, getAttribute: () => null };
  const fileInput = { disabled: false, files: [], dispatchEvent() { uploads.push(...this.files); actions.push('attach'); } };
  const unrelatedInput = { files: [], dispatchEvent() { actions.push('unrelated-upload'); } };
  const button = { disabled: false, getAttribute: () => null, click: () => {
    clicked++;
    if (success) {
      toasts = [{ textContent: 'Your post was sent.' }];
      for (const observer of [...observers]) observer.callback();
    }
  } };
  const root = { parentElement: null, querySelector: selector => selector.includes('input') ? fileInput : selector.includes('attachments') ? uploadReady ? {} : null : button };
  editor.parentElement = root;
  const selection = { removeAllRanges() {}, addRange() {} };
  loadModule('src/content/x-reply-automator.ts', {
    location: { pathname: '/user/status/1', href: 'https://x.com/user/status/1' },
    document: {
      body: {},
      querySelector: selector => selector.includes('Profile_Link') ? { getAttribute: () => '/' + account }
        : selector.includes('input') ? unrelatedInput : editor,
      querySelectorAll: selector => selector.includes('toast') ? toasts : [editor],
      createRange: () => ({ selectNodeContents() {}, collapse() {} }), getSelection: () => selection,
      execCommand: (_command, _show, text) => { editor.innerText += text; actions.push('caption'); },
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    Event, File, atob,
    DataTransfer: class { files = []; items = { add: file => this.files.push(file) }; },
    setTimeout: (callback, ms) => {
      if (ms === 300) queueMicrotask(callback);
      else timers.set(ms, callback);
      return ms;
    },
    clearTimeout: ms => { timers.delete(ms); },
    chrome: { runtime: {
      onMessage: { addListener: listener => { onMessage = listener; } },
      sendMessage: async message => {
        messages.push(message);
        if (message.type === 'GET_REPLY_WORK') return { work: {
          jobId: 'job-1', token: 'attempt-1', tweetId: '1', account: 'monkeys_com_co', caption: 'Here is your Monkeys snapshot.',
          dataUrl, deadline: Date.now() + 180_000,
        } };
        if (message.type === 'CLAIM_REPLY_COMPOSE') return { accepted: composeAllowed };
        return { accepted: allowed };
      },
    } },
  });
  return { messages, timers, actions, uploads, editor, get clicked() { return clicked; }, trigger: () => onMessage({ type: 'CHECK_AND_RUN_REPLY' }) };
}

test('reply script claims once before clicking, confirms actual success and ignores concurrent triggers', async () => {
  const env = replyEnvironment(); env.trigger(); env.trigger();
  await new Promise(setImmediate);
  assert.equal(env.messages.filter(message => message.type === 'GET_REPLY_WORK').length, 1);
  assert.equal(env.clicked, 1);
  assert.equal(env.messages.at(-1).type, 'REPLY_CONFIRMED');
});

test('rejected posting permission never clicks Reply', async () => {
  const env = replyEnvironment({ allowed: false });
  await new Promise(setImmediate);
  assert.equal(env.clicked, 0);
});

test('a reply with no success receipt becomes uncertain instead of being marked posted', async () => {
  const env = replyEnvironment({ success: false });
  await new Promise(setImmediate);
  env.timers.get(30_000)?.();
  await new Promise(setImmediate);
  assert.equal(env.clicked, 1);
  assert.equal(env.messages.at(-1).type, 'REPLY_UNCERTAIN');
});

test('a different signed-in account pauses automation before composing or posting', async () => {
  const env = replyEnvironment({ account: 'someone_else' });
  await new Promise(setImmediate);
  assert.equal(env.clicked, 0);
  assert.equal(env.messages.at(-1).type, 'AUTOMATION_BLOCKED');
});

test('a form-less X composer uses its own upload control and attaches the image before typing', async () => {
  const env = replyEnvironment({ withoutForm: true, dataUrl: 'data:image/jpeg;base64,YQ==' });
  await new Promise(setImmediate);
  assert.deepEqual(env.actions, ['attach', 'caption']);
  assert.equal(env.uploads.length, 1);
  assert.equal(env.uploads[0].type, 'image/jpeg');
  assert.match(env.uploads[0].name, /\.jpg$/);
  assert.equal(env.clicked, 1);
});

test('an attachment timeout leaves no caption-only draft and never clicks Reply', async () => {
  const env = replyEnvironment({ uploadReady: false });
  await new Promise(setImmediate);
  env.timers.get(20_000)?.();
  await new Promise(setImmediate);
  assert.equal(env.editor.innerText, '');
  assert.equal(env.clicked, 0);
  assert.equal(env.messages.at(-1).type, 'JOB_FAILED');
});

test('a rejected compose claim cannot type or upload even when final posting permission would pass', async () => {
  const env = replyEnvironment({ composeAllowed: false });
  await new Promise(setImmediate);
  assert.deepEqual(env.actions, []);
  assert.equal(env.clicked, 0);
});

test('an existing draft pauses automation without appending a second caption', async () => {
  const env = replyEnvironment({ draft: 'Here is your Monkeys snapshot.' });
  await new Promise(setImmediate);
  assert.equal(env.editor.innerText, 'Here is your Monkeys snapshot.');
  assert.deepEqual(env.actions, []);
  assert.equal(env.messages.at(-1).type, 'AUTOMATION_BLOCKED');
});

test('asynchronous image blobs retain the originating attempt token', () => {
  let token = 'old-attempt';
  let reader;
  const posted = [];
  const window = { URL: { createObjectURL: () => 'blob:png' }, addEventListener() {}, postMessage: message => posted.push(message) };
  loadModule('public/injected-interceptor.js', {
    navigator: {}, window, Blob,
    document: { documentElement: { getAttribute: name => name.endsWith('until') ? String(Date.now() + 60_000) : token } },
    FileReader: class {
      constructor() { reader = this; }
      readAsDataURL() { this.result = 'data:image/png;base64,YQ=='; }
    },
  });
  window.URL.createObjectURL(new Blob(['image'], { type: 'image/png' }));
  token = 'new-attempt';
  reader.onload();
  assert.equal(posted.find(message => message.type === 'MONKEYS_INTERCEPTED_BLOB').token, 'old-attempt');
});

function exportEnvironment() {
  const posted = [];
  const drawn = [];
  const window = { URL: { createObjectURL: () => 'blob:png' }, addEventListener() {}, postMessage: message => posted.push(message) };
  loadModule('public/injected-interceptor.js', {
    navigator: {}, window, Blob,
    document: {
      documentElement: { getAttribute: name => name.endsWith('until') ? String(Date.now() + 60_000) : 'attempt-1' },
      createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, drawImage: (...args) => drawn.push(args) }),
        toBlob: callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })) }),
    },
    createImageBitmap: async () => ({ width: 2160, height: 2700, close() {} }),
    FileReader: class {
      readAsDataURL(blob) { blob.arrayBuffer().then(bytes => { this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`; this.onload(); }); }
    },
  });
  return { get posted() { return posted.filter(message => message.type === 'MONKEYS_INTERCEPTED_BLOB'); }, drawn, capture: blob => window.URL.createObjectURL(blob) };
}

test('large Studio PNGs are resized and compressed before crossing the extension message boundary', async () => {
  const env = exportEnvironment();
  env.capture(new Blob([new Uint8Array(5_000_000)], { type: 'image/png' }));
  await new Promise(setImmediate);
  assert.equal(env.posted.length, 1);
  assert.match(env.posted[0].dataUrl.slice(0, 32), /^data:image\/jpeg;base64,/);
  assert.ok(env.posted[0].dataUrl.length < 6_000_000);
  assert.equal(env.posted[0].token, 'attempt-1');
  assert.equal(env.drawn[0][3], 1280);
  assert.equal(env.drawn[0][4], 1600);
});

test('intermediate SVG image blobs do not consume the screenshot export', async () => {
  const env = exportEnvironment();
  env.capture(new Blob(['<svg/>'], { type: 'image/svg+xml' }));
  await new Promise(setImmediate);
  assert.equal(env.posted.length, 0);
  env.capture(new Blob(['png'], { type: 'image/png' }));
  await new Promise(setImmediate);
  assert.match(env.posted[0].dataUrl, /^data:image\/png;base64,/);
});

test('Studio response diagnostics expose mention counts without copying tweet text or changing the response', async () => {
  const posted = [];
  const text = '@monkeys_com_co Hey @monkeys_com_co snapshot this';
  const response = new Response(JSON.stringify({ id_str: '123', text, display_text_range: [16, text.length] }), { status: 200 });
  const window = { fetch: async () => response, URL: { createObjectURL() {} }, addEventListener() {}, postMessage: message => posted.push(message) };
  loadModule('public/injected-interceptor.js', {
    window, navigator: {}, Blob, location: { href: 'https://studio.example.com/snapshot/new', origin: 'https://studio.example.com' },
    document: { documentElement: { getAttribute: name => name === 'data-monkeys-job-token' ? 'attempt-1' : null } },
  });
  const result = await window.fetch('/api/snapshot/tweet/123');
  for (let i = 0; i < 5 && !posted.length; i++) await new Promise(setImmediate);
  assert.equal((await result.json()).text, text);
  assert.equal(posted[0]?.type, 'MONKEYS_STUDIO_POST_METADATA');
  assert.equal(posted[0].mentionCount, 2);
  assert.equal(posted[0].displayTextStart, 16);
  assert.equal(posted[0].textLength, text.length);
  assert.equal(JSON.stringify(posted).includes('snapshot this'), false);
});

test('Studio response tracing ignores unarmed requests and unrelated endpoints or origins', async () => {
  const posted = [];
  let token = null;
  const window = { fetch: async () => new Response(JSON.stringify({ text: 'private response' })),
    URL: { createObjectURL() {} }, addEventListener() {}, postMessage: message => posted.push(message) };
  loadModule('public/injected-interceptor.js', {
    window, navigator: {}, Blob, location: { href: 'https://studio.example.com/snapshot/new', origin: 'https://studio.example.com' },
    document: { documentElement: { getAttribute: name => name === 'data-monkeys-job-token' ? token : null } },
  });
  await window.fetch('/api/snapshot/tweet/123');
  token = 'attempt-1';
  await window.fetch('/api/private/account');
  await window.fetch('https://elsewhere.example.com/api/snapshot/tweet/123');
  await new Promise(setImmediate);
  assert.equal(posted.length, 0);
});

test('an armed background export completes an animation-frame wait once even if native frames stop', () => {
  const native = new Map(); const timers = new Map(); let nextId = 0; const called = [];
  let token = 'attempt-1';
  const window = { URL: { createObjectURL() {} }, addEventListener() {}, postMessage() {},
    requestAnimationFrame: callback => { native.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: id => native.delete(id) };
  loadModule('public/injected-interceptor.js', {
    window, navigator: {}, Blob, performance: { now: () => 123 },
    setTimeout: callback => { const id = ++nextId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    document: { visibilityState: 'hidden', documentElement: { getAttribute: name => name.endsWith('until') ? String(Date.now() + 60_000) : token } },
  });
  const id = window.requestAnimationFrame(time => called.push(time));
  const nativeCallback = native.get(id);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  nativeCallback(999);
  assert.deepEqual(called, [123]);
  assert.equal(native.has(id), false);
  const cancelled = window.requestAnimationFrame(time => called.push(time));
  window.cancelAnimationFrame(cancelled);
  assert.equal(timers.size, 0);
  assert.equal(called.length, 1);
  const uiFrame = window.requestAnimationFrame(time => called.push(time));
  token = null;
  native.get(uiFrame)(456);
  assert.deepEqual(called, [123, 456]);
});
