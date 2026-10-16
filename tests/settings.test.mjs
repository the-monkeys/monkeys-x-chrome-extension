import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function loadModule(file, globals, cache = new Map()) {
  const filename = resolve(file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    console, URL, ...globals, module, exports: module.exports,
    require: name => name.startsWith('.')
      ? loadModule(resolve(dirname(filename), `${name}.ts`), globals, cache)
      : createRequire(import.meta.url)(name),
  }, { filename });
  return module.exports;
}

function settingsEnvironment(initial = {}) {
  let stored = { ...initial };
  const chrome = {
    runtime: {},
    storage: { sync: {
      get: (defaults, callback) => callback({ ...defaults, ...stored }),
      set: (values, callback) => { stored = { ...stored, ...values }; callback(); },
    } },
  };
  return { chrome, storage: loadModule('src/lib/storage.ts', { chrome }) };
}

test('saved account and Studio URL are normalized for reuse', async () => {
  const { storage } = settingsEnvironment();
  await storage.saveSettings({ xUsername: ' @Other_Bot ', studioUrl: 'https://example.com/snapshot/new?draft=1' });
  const settings = await storage.getSettings();
  assert.equal(settings.xUsername, 'other_bot');
  assert.equal(settings.studioUrl, 'https://example.com');
});

test('invalid accounts and unsafe Studio URLs cannot be saved', async () => {
  const { storage } = settingsEnvironment();
  await assert.rejects(storage.saveSettings({ xUsername: 'not an account' }));
  await assert.rejects(storage.saveSettings({ studioUrl: 'javascript:alert(1)' }));
  await assert.rejects(storage.saveSettings({ studioUrl: 'https://user:password@example.com' }));
});

test('existing installs get new defaults and always use Midnight despite a saved theme', async () => {
  const { storage } = settingsEnvironment({ selectedTheme: 'forest', targetHandles: ['monkeys'] });
  const settings = await storage.getSettings();
  assert.equal(settings.xUsername, 'monkeys_com_co');
  assert.equal(settings.studioUrl, 'https://incredible-eclair-ada155.netlify.app');
  assert.equal(settings.selectedTheme, 'midnight');
});

test('manual screenshot jobs use Midnight even when given a stale settings object', async () => {
  let sent;
  const api = loadModule('src/lib/api.ts', { fetch: async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ id: 'job-1' }) };
  } });
  await api.createJob({ orchestratorUrl: 'http://localhost:3000', selectedTheme: 'forest', selectedAspect: '1080x1080' }, '123');
  assert.equal(sent.options.theme, 'midnight');
});

test('only the configured Studio receives scripts, including when switching to production', async () => {
  const registered = new Map();
  const chrome = {
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => [...registered.values()],
      registerContentScripts: async scripts => scripts.forEach(script => registered.set(script.id, script)),
      updateContentScripts: async scripts => scripts.forEach(script => registered.set(script.id, script)),
    },
  };
  const studio = loadModule('src/lib/studio.ts', { chrome });
  await studio.configureStudioScripts('https://preview.example.com');
  assert.equal(registered.size, 2);
  await studio.configureStudioScripts('https://monkeys.com.co');
  for (const script of registered.values()) {
    assert.equal(script.matches.join(','), 'https://monkeys.com.co/snapshot/*');
  }
  assert.equal([...registered.values()].find(script => script.world === 'MAIN').js[0], 'injected-interceptor.js');
});

test('Studio configuration cannot register scripts without access to the selected site', async () => {
  const studio = loadModule('src/lib/studio.ts', {
    chrome: { permissions: { contains: async () => false } },
  });
  await assert.rejects(studio.configureStudioScripts('https://example.com'), /access/i);
});

test('notification tabs match only the configured account and pick up settings changes', async () => {
  const articles = [
    ['101', '@New_Bot screenshot this'],
    ['102', '@new_bot_extra screenshot this'],
    ['103', '@monkeys_com_co screenshot this'],
    ['104', 'email@new_bot screenshot this'],
    ['105', '@NEW_BOT screenshot this'],
  ].map(([id, textContent]) => {
    const article = { textContent, getAttribute: () => null,
      querySelectorAll: selector => selector === 'time' ? [{ closest: selector => selector === 'article' ? article
        : selector.includes('quoteTweet') ? null : { getAttribute: () => `/requester/status/${id}` } }]
        : [{ closest: () => null, cloneNode: () => ({ textContent, querySelectorAll: () => [] }) }],
    };
    return article;
  });
  const messages = [];
  let changed;
  loadModule('src/content/notifications-watcher.ts', {
    document: { body: {}, querySelectorAll: () => articles },
    location: { pathname: '/notifications', href: 'https://x.com/notifications' },
    MutationObserver: class { observe() {} },
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async message => { messages.push(message); return { accepted: true }; } },
      storage: {
        onChanged: { addListener: listener => { changed = listener; } },
        sync: { get: async () => ({ xUsername: 'new_bot' }) },
        local: { get: async () => ({}), set: async () => {} },
      },
    },
  });
  await new Promise(setImmediate);
  assert.deepEqual(messages.filter(message => message.type === 'MENTION_DETECTED').map(message => message.payload.tweetId), ['101', '105']);
  changed({ xUsername: { newValue: 'monkeys_com_co' } }, 'sync');
  await new Promise(setImmediate);
  assert.deepEqual(messages.filter(message => message.type === 'MENTION_DETECTED').map(message => message.payload.tweetId), ['101', '105', '103']);
});

function runSnapshot({ hasMidnight = true, origin = 'https://studio.example.com', hasBridge = true, loading = false } = {}) {
  const actions = [];
  const input = { offsetParent: {}, focus() {}, dispatchEvent() {} };
  const midnight = { textContent: 'Midnight', click: () => actions.push('midnight') };
  const copy = { click: () => actions.push('export'), dispatchEvent() {}, getAttribute: () => null };
  const download = { textContent: 'Download', disabled: false, getAttribute: () => null, click: () => actions.push('download') };
  const listeners = new Set();
  const window = { addEventListener: (_event, listener) => listeners.add(listener), removeEventListener: (_event, listener) => listeners.delete(listener),
    postMessage: message => { if (hasBridge && message.type === 'MONKEYS_BRIDGE_PING') queueMicrotask(() => {
      for (const listener of [...listeners]) listener({ source: window, data: { type: 'MONKEYS_BRIDGE_READY', token: message.token, version: '2' } });
    }); } };
  loadModule('src/content/snapshot-automator.ts', {
    console: { log() {}, warn() {}, error() {} },
    location: { origin },
    window,
    NodeFilter: { SHOW_TEXT: 4 }, Event, MouseEvent: Event,
    setTimeout: (callback, ms) => { if (ms !== 5000 || !hasBridge) queueMicrotask(callback); return 0; },
    clearTimeout() {}, MutationObserver: class { observe() {} disconnect() {} },
    document: {
      documentElement: { setAttribute() {}, removeAttribute() {} },
      body: {}, createTreeWalker: () => ({ nextNode: () => null }),
      querySelector: selector => selector.includes('title') ? copy : selector === 'section' ? { textContent: loading ? 'X-Screenshot Loading post…' : 'X-Screenshot Play + Screenshot request text 0 likes' } : null,
      querySelectorAll: selector => {
        if (selector === 'button[role="tab"]') return [{ textContent: 'X screenshot', getAttribute: () => 'true' }];
        if (selector === 'input#snap-tweet-url') return [input];
        if (selector === 'button') return hasMidnight ? [midnight, download] : [download];
        return [];
      },
    },
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async message => message.type === 'GET_SNAPSHOT_WORK' ? { work: {
        jobId: 'test-job', token: 'attempt-1', deadline: Date.now() + 60_000,
        tweetId: '123', tweetUrl: 'https://x.com/person/status/123', studioOrigin: 'https://studio.example.com',
      } } : { accepted: true } },
      storage: { local: {
        get: async () => ({ monkeys_pending_snapshot: {
          tweetId: '123', tweetUrl: 'https://x.com/person/status/123', studioOrigin: 'https://studio.example.com',
        } }),
        remove: async () => {},
      } },
    },
  });
  return actions;
}

test('Studio selects Midnight before exporting and stops if Midnight is unavailable', async () => {
  const actions = runSnapshot();
  const unavailable = runSnapshot({ hasMidnight: false });
  const oldStudio = runSnapshot({ origin: 'https://old.example.com' });
  await new Promise(setImmediate);
  assert.deepEqual(actions, ['midnight', 'download']);
  assert.deepEqual(unavailable, []);
  assert.deepEqual(oldStudio, []);
});

test('Studio never exports a loading preview or runs without the MAIN-world bridge', async () => {
  const loading = runSnapshot({ loading: true });
  const missingBridge = runSnapshot({ hasBridge: false });
  await new Promise(setImmediate);
  assert.deepEqual(loading, []);
  assert.deepEqual(missingBridge, []);
});

test('interceptor leaves manual downloads alone when no Studio export is active', () => {
  let click;
  let prevented = false;
  loadModule('public/injected-interceptor.js', {
    navigator: {},
    window: {
      URL: { createObjectURL: () => 'blob:original' },
      addEventListener: (_name, listener) => { click = listener; },
      postMessage() {},
    },
    document: { body: {}, documentElement: { getAttribute: () => null } },
  });
  click({
    target: { tagName: 'A', hasAttribute: () => true, getAttribute: () => 'data:image/png;base64,abc' },
    preventDefault: () => { prevented = true; }, stopPropagation() {},
  });
  assert.equal(prevented, false);
});
