import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './harness.mjs';

function environment({ manualTimers = false } = {}) {
  let now = 1_000_000;
  let nextTab = 0;
  let nextToken = 0;
  let online = true;
  let healthReady = true;
  let hangHealth = false;
  const timers = new Set();
  let browserSession = 'browser-1';
  const data = {};
  const tabs = new Map();
  const events = [];
  const settings = { xUsername: 'monkeys_com_co', studioUrl: 'https://studio.example.com', autoReply: true, keepAwake: true };
  const chrome = {
    storage: { local: {
      get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, structuredClone(data[key])])),
      set: async values => { Object.assign(data, structuredClone(values)); },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    } },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('Tab closed'); return { ...tabs.get(id) }; },
      query: async () => [...tabs.values()].map(tab => ({ ...tab })),
      create: async details => {
        await new Promise(setImmediate);
        const tab = { ...details, id: ++nextTab, status: 'complete' };
        tabs.set(tab.id, tab); events.push(['create', tab.id]); return { ...tab };
      },
      update: async (id, details) => { const tab = tabs.get(id); if (!tab) throw new Error('Tab closed'); Object.assign(tab, details); return { ...tab }; },
      reload: async id => { events.push(['reload', id]); },
      sendMessage: async (id, message) => {
        if (!tabs.has(id)) throw new Error('Tab closed');
        events.push([message.type, id]);
        if (hangHealth && message.type === 'SCAN_NOTIFICATIONS') return new Promise(() => {});
        return { ready: healthReady, scannedAt: now };
      },
    },
    power: { requestKeepAwake: level => events.push(['power', level]), releaseKeepAwake: () => events.push(['release']) },
  };
  const { AutomationController } = loadModule('src/background/automation.ts', { chrome, ...(manualTimers ? {
    setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: callback => timers.delete(callback),
  } : {}) });
  const options = { settings: async () => ({ ...settings }), configureStudio: async () => {}, now: () => now, token: () => `attempt-${++nextToken}`, online: () => online, session: async () => browserSession };
  const makeController = () => {
    const instance = new AutomationController(options);
    const handle = instance.handle.bind(instance);
    instance.handle = (message, sender) => handle({ buildId: 'test-build', ...message }, sender);
    return instance;
  };
  let controller = makeController();
  return {
    chrome, data, tabs, events, settings,
    get controller() { return controller; },
    advance: ms => { now += ms; },
    setOnline: value => { online = value; },
    setHealthReady: value => { healthReady = value; },
    setHangHealth: value => { hangHealth = value; },
    expireMessages: () => { for (const callback of [...timers]) callback(); },
    restart: () => { controller = makeController(); return controller; },
    browserRestart: () => { browserSession += '-next'; controller = makeController(); return controller; },
    request: id => controller.handle({ type: 'MENTION_DETECTED', payload: { tweetId: String(id), tweetUrl: `https://x.com/author/status/${id}`, detectedAt: new Date(now).toISOString() } }, { url: 'https://x.com/notifications', tab: { id: 999 } }),
    status: () => controller.handle({ type: 'GET_AUTOMATION_STATUS' }, {}),
  };
}

test('100 simultaneous requests use one Studio tab and overflow is rejected without losing admitted work', async () => {
  const env = environment();
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => env.request(i + 1)));
  assert.equal(results.filter(result => result.accepted).length, 100);
  assert.equal((await env.status()).pendingCount, 100);
  assert.equal([...env.tabs.values()].filter(tab => tab.url.includes('/snapshot/')).length, 1);
  assert.equal((await env.request(101)).accepted, false);
  assert.equal((await env.status()).pendingCount, 100);
  assert.equal((await env.request(1)).accepted, true);
  assert.match((await env.status()).warning, /full/i);
});

test('diagnostics persist target decisions and sanitized script steps across worker restarts', async () => {
  const env = environment(); env.settings.apiKey = 'secret-test-key'; await env.request(1);
  const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
  await env.controller.handle({ type: 'AUTOMATION_TRACE', component: 'studio', event: 'export_ready', buildId: 'test-build',
    details: { found: true, imageCharacters: 1234, dataUrl: 'data:image/png;base64,secret', apiKey: 'secret-test-key', cookies: 'secret-cookie', html: '<secret>' } }, { tab: studio, url: studio.url });
  await env.request(2); env.restart();
  const report = await env.controller.handle({ type: 'GET_DIAGNOSTICS' }, {});
  assert.equal(report.buildId, 'test-build');
  assert.ok(report.events.some(event => event.event === 'request_queued' && event.details.targetUrl === 'https://x.com/author/status/1'));
  assert.ok(report.events.some(event => event.event === 'request_queued' && event.details.requestId === '2' && event.jobId === 'monkeys_com_co:2'));
  assert.ok(report.events.some(event => event.event === 'export_ready' && event.details.imageCharacters === 1234));
  assert.ok(report.scripts.some(script => script.component === 'studio' && script.buildId === 'test-build'));
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.equal((await env.controller.handle({ type: 'GET_DIAGNOSTICS' }, { tab: studio, url: studio.url })).accepted, false);
});

test('diagnostic storage remains bounded under repeated content-script messages', async () => {
  const env = environment(); await env.request(1);
  for (let i = 0; i < 350; i++) await env.controller.handle({ type: 'AUTOMATION_TRACE', component: 'watcher', event: 'scan_complete', details: { editorCount: i } }, { url: 'https://x.com/notifications', tab: { id: 999 } });
  const report = await env.controller.handle({ type: 'GET_DIAGNOSTICS' }, {});
  assert.ok(report.events.length <= 300);
  assert.equal(report.events.at(-1).details.editorCount, 349);
});

test('late content traces keep their producer identity instead of being attributed to a newer attempt', async () => {
  const env = environment(); await env.request(1);
  const old = (await env.status()).activeJob;
  const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
  env.advance(240_000); await env.controller.pulse(); env.advance(61_000); await env.controller.pulse();
  await env.controller.handle({ type: 'AUTOMATION_TRACE', component: 'studio', event: 'late_export', jobId: old.id, token: old.token }, { tab: studio, url: studio.url });
  let report = await env.controller.handle({ type: 'GET_DIAGNOSTICS' }, {});
  assert.equal(report.events.at(-1).stale, true);
  assert.equal(report.events.at(-1).attempt, undefined);
  await env.controller.handle({ type: 'AUTOMATION_TRACE', component: 'reply', event: 'script_ready' }, { tab: { id: 888 }, url: 'https://x.com/home' });
  report = await env.controller.handle({ type: 'GET_DIAGNOSTICS' }, {});
  assert.equal(report.events.at(-1).jobId, undefined);
});

test('old or unidentified reply scripts cannot obtain work or authorize a post', async () => {
  const env = environment(); const { job, sender } = await makeReplyReady(env);
  for (const buildId of ['old-build', undefined]) {
    assert.equal((await env.controller.handle({ type: 'GET_REPLY_WORK', buildId }, sender)).work, null);
    assert.equal((await env.controller.handle({ type: 'CLAIM_REPLY', buildId, payload: { jobId: job.id, token: job.token } }, sender)).accepted, false);
  }
  assert.ok((await env.controller.handle({ type: 'GET_REPLY_WORK' }, sender)).work);
  assert.equal((await env.status()).buildId, 'test-build');
});

test('an unresponsive health message cannot block the queue or prevent a saved retry', async () => {
  const env = environment({ manualTimers: true }); await env.request(1);
  const job = (await env.status()).activeJob;
  const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
  await env.controller.handle({ type: 'SNAPSHOT_DOWNLOADED', payload: { jobId: job.id, token: job.token, dataUrl: 'bad image' } }, { tab: studio, url: studio.url });
  env.setHangHealth(true);
  const pulse = env.controller.pulse();
  await new Promise(setImmediate);
  const status = env.status();
  env.expireMessages();
  // Bound the test independently: the old code leaves both calls pending forever.
  await Promise.race([pulse, new Promise((_, reject) => setTimeout(() => reject(new Error('Health message blocked the controller')), 100))]);
  assert.equal((await status).activeJob.stage, 'retry_wait');
  env.setHangHealth(false); env.advance(61_000); await env.controller.pulse();
  assert.equal((await env.status()).activeJob.attempts, 2);
  assert.equal((await env.status()).activeJob.stage, 'rendering');
  assert.equal(env.tabs.size, 2);
});

test('restarts preserve queued work and late screenshot callbacks cannot change the next attempt', async () => {
  const env = environment();
  await env.request(1); await env.request(2);
  const old = (await env.status()).activeJob;
  env.advance(4 * 60_000);
  await env.restart().pulse();
  env.advance(61_000); await env.controller.pulse();
  const current = (await env.status()).activeJob;
  assert.notEqual(current.token, old.token);
  const result = await env.controller.handle({ type: 'SNAPSHOT_DOWNLOADED', payload: {
    jobId: old.id, token: old.token, dataUrl: 'data:image/png;base64,YQ==',
  } }, { tab: { id: 2 }, url: 'https://studio.example.com/snapshot/new' });
  assert.equal(result.accepted, false);
  assert.equal((await env.status()).pendingCount, 2);
});

async function makeReplyReady(env) {
  await env.request(1);
  const job = (await env.status()).activeJob;
  const studioTab = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
  await env.controller.handle({ type: 'SNAPSHOT_DOWNLOADED', payload: {
    jobId: job.id, token: job.token, dataUrl: 'data:image/png;base64,YQ==',
  } }, { tab: studioTab, url: studioTab.url });
  const replyTab = [...env.tabs.values()].find(tab => tab.url.includes('/i/status/'));
  return { job, sender: { tab: replyTab, url: replyTab.url } };
}

test('reply authorization is single-use and an uncertain submission blocks automatic retries', async () => {
  const env = environment();
  const { job, sender } = await makeReplyReady(env);
  const claim = { type: 'CLAIM_REPLY', payload: { jobId: job.id, token: job.token } };
  assert.equal((await env.controller.handle(claim, sender)).accepted, true);
  assert.equal((await env.controller.handle(claim, sender)).accepted, false);
  env.advance(4 * 60_000); await env.restart().pulse();
  const status = await env.status();
  assert.equal(status.activeJob.stage, 'needs_review');
  assert.equal((await env.controller.handle(claim, sender)).accepted, false);
});

test('only one content-script instance may claim reply composition for an attempt', async () => {
  const env = environment(); const { job, sender } = await makeReplyReady(env);
  const message = { type: 'CLAIM_REPLY_COMPOSE', payload: { jobId: job.id, token: job.token } };
  const results = await Promise.all([env.controller.handle(message, sender), env.controller.handle(message, sender)]);
  assert.equal(results.filter(result => result.accepted).length, 1);
  assert.equal((await env.status()).activeJob.stage, 'reply_ready');
  assert.equal((await env.restart().handle(message, sender)).accepted, false);
});

test('a draft conflict can resume preparation after the user clears it and presses Start', async () => {
  const env = environment(); const { job, sender } = await makeReplyReady(env);
  const claim = { type: 'CLAIM_REPLY_COMPOSE', payload: { jobId: job.id, token: job.token } };
  await env.controller.handle(claim, sender);
  await env.controller.handle({ type: 'AUTOMATION_BLOCKED', payload: { jobId: job.id, token: job.token, error: 'Draft conflict' } }, sender);
  assert.equal((await env.status()).enabled, false);
  env.advance(4 * 60_000); await env.controller.pulse();
  assert.equal((await env.status()).activeJob.stage, 'reply_ready');
  await env.controller.handle({ type: 'AUTOMATION_CONTROL', action: 'start' }, {});
  assert.equal((await env.controller.handle(claim, sender)).accepted, true);
  assert.equal((await env.status()).activeJob.stage, 'reply_ready');
});

test('a confirmed reply goes to the request, completes once and reuses the three tabs', async () => {
  const env = environment();
  const { job, sender } = await makeReplyReady(env);
  await env.request(2);
  assert.equal(new URL(sender.url).pathname, '/i/status/1');
  await env.controller.handle({ type: 'CLAIM_REPLY', payload: { jobId: job.id, token: job.token } }, sender);
  const confirmed = { type: 'REPLY_CONFIRMED', payload: { jobId: job.id, token: job.token } };
  assert.equal((await env.controller.handle(confirmed, sender)).accepted, true);
  assert.equal((await env.controller.handle(confirmed, sender)).accepted, false);
  assert.equal((await env.status()).pendingCount, 1);
  assert.equal(env.tabs.size, 3);
});

test('closing a Studio tab recovers with bounded retries instead of opening unbounded tabs', async () => {
  const env = environment(); await env.request(1);
  for (let i = 0; i < 3; i++) {
    const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
    if (studio) { env.tabs.delete(studio.id); await env.controller.tabRemoved(studio.id); }
    env.advance(4 * 60_000); await env.controller.pulse();
  }
  assert.equal((await env.status()).pendingCount, 0);
  assert.equal((await env.status()).jobs[0].stage, 'failed');
  assert.ok(env.tabs.size <= 3);
});

test('pause stops admission and dispatch; disabled Auto Reply waits for manual approval', async () => {
  const env = environment(); env.settings.autoReply = false;
  await env.controller.handle({ type: 'AUTOMATION_CONTROL', action: 'pause' }, {});
  assert.equal((await env.request(1)).accepted, false);
  await env.controller.handle({ type: 'AUTOMATION_CONTROL', action: 'start' }, {});
  await env.request(1);
  const job = (await env.status()).activeJob;
  const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
  await env.controller.handle({ type: 'SNAPSHOT_DOWNLOADED', payload: { jobId: job.id, token: job.token, dataUrl: 'data:image/png;base64,YQ==' } }, { tab: studio, url: studio.url });
  assert.equal((await env.status()).activeJob.stage, 'awaiting_approval');
  assert.equal(env.tabs.size, 2);
  await env.controller.handle({ type: 'AUTOMATION_CONTROL', action: 'approve', jobId: job.id }, {});
  assert.equal((await env.status()).activeJob.stage, 'reply_ready');
  assert.equal(env.tabs.size, 3);
});

test('health scans have a refresh cooldown and pause releases keep-awake', async () => {
  const env = environment(); await env.controller.pulse();
  await env.controller.pulse();
  assert.equal(env.events.filter(event => event[0] === 'reload').length, 1);
  env.advance(180_000); await env.controller.pulse();
  assert.equal(env.events.filter(event => event[0] === 'reload').length, 2);
  await env.controller.handle({ type: 'AUTOMATION_CONTROL', action: 'pause' }, {});
  assert.equal(env.events.at(-1)[0], 'release');
});

test('a settings change cannot post a queued request through another account', async () => {
  const env = environment(); const { job, sender } = await makeReplyReady(env);
  env.settings.xUsername = 'another_account';
  assert.equal((await env.controller.handle({ type: 'CLAIM_REPLY', payload: { jobId: job.id, token: job.token } }, sender)).accepted, false);
  await env.controller.pulse();
  assert.match((await env.status()).warning, /settings changed/i);
});

test('unrelated tabs cannot retrieve screenshots or authorize a reply', async () => {
  const env = environment(); const { job, sender } = await makeReplyReady(env);
  const unrelated = { ...sender, tab: { ...sender.tab, id: 999 } };
  assert.equal((await env.controller.handle({ type: 'GET_REPLY_WORK' }, unrelated)).work, null);
  assert.equal((await env.controller.handle({ type: 'CLAIM_REPLY', payload: { jobId: job.id, token: job.token } }, unrelated)).accepted, false);
});

test('a wrong or oversized image fails safely and exhausts three attempts', async () => {
  const env = environment(); await env.request(1);
  for (let i = 0; i < 3; i++) {
    const job = (await env.status()).activeJob;
    const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
    await env.controller.handle({ type: 'SNAPSHOT_DOWNLOADED', payload: { jobId: job.id, token: job.token, dataUrl: i === 0 ? 'data:image/png;base64,' + 'a'.repeat(6_000_000) : 'bad image' } }, { tab: studio, url: studio.url });
    env.advance(180_000); await env.controller.pulse();
  }
  assert.equal((await env.status()).pendingCount, 0);
  assert.equal((await env.status()).jobs[0].stage, 'failed');
});

test('100 completed requests reuse the same three tab IDs', async () => {
  const env = environment();
  await Promise.all(Array.from({ length: 100 }, (_, i) => env.request(i + 1)));
  for (let i = 0; i < 100; i++) {
    const job = (await env.status()).activeJob;
    const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
    await env.controller.handle({ type: 'SNAPSHOT_DOWNLOADED', payload: { jobId: job.id, token: job.token, dataUrl: 'data:image/png;base64,YQ==' } }, { tab: studio, url: studio.url });
    const reply = [...env.tabs.values()].find(tab => tab.url.includes('/i/status/'));
    const sender = { tab: reply, url: reply.url };
    await env.controller.handle({ type: 'CLAIM_REPLY', payload: { jobId: job.id, token: job.token } }, sender);
    await env.controller.handle({ type: 'REPLY_CONFIRMED', payload: { jobId: job.id, token: job.token } }, sender);
  }
  assert.equal((await env.status()).pendingCount, 0);
  assert.equal(env.events.filter(event => event[0] === 'create').length, 3);
  assert.equal((await env.status()).jobs.length, 50);
});

test('a tab created just before a worker crash is recovered instead of duplicated', async () => {
  const env = environment();
  await env.request(1);
  const state = env.data.monkeys_automation_state;
  delete state.tabs.studio; // crash between Chrome creating the tab and saving its ID
  env.advance(240_000); await env.restart().pulse();
  env.advance(61_000); await env.controller.pulse();
  assert.equal([...env.tabs.values()].filter(tab => tab.url.includes('/snapshot/')).length, 1);
});

test('offline time does not consume retry attempts; reconnection resumes saved work', async () => {
  const env = environment(); await env.request(1); env.setOnline(false);
  for (let i = 0; i < 10; i++) { env.advance(180_000); await env.controller.pulse(); }
  assert.equal((await env.status()).activeJob.attempts, 1);
  assert.equal((await env.status()).pendingCount, 1);
  assert.match((await env.status()).warning, /offline/i);
  env.setOnline(true); await env.controller.pulse();
  env.advance(61_000); await env.controller.pulse();
  assert.equal((await env.status()).activeJob.attempts, 2);
});

test('legacy pending replies require review rather than being submitted again', async () => {
  const env = environment(); env.data.monkeys_pending_reply = { tweetId: '99', targetTweetId: '88', dataUrl: 'data:image/png;base64,YQ==' };
  await env.controller.pulse();
  assert.equal((await env.status()).activeJob.stage, 'needs_review');
  assert.equal((await env.status()).activeJob.reviewTweetId, '88');
  assert.equal(env.events.filter(event => event[0] === 'CHECK_AND_RUN_REPLY').length, 0);
  await env.controller.handle({ type: 'AUTOMATION_CONTROL', action: 'resolve_posted', jobId: 'monkeys_com_co:99' }, {});
  assert.equal((await env.status()).pendingCount, 0);
});

test('stale popup controls cannot skip a different request after the queue advances', async () => {
  const env = environment(); const { job, sender } = await makeReplyReady(env); await env.request(2);
  await env.controller.handle({ type: 'CLAIM_REPLY', payload: { jobId: job.id, token: job.token } }, sender);
  await env.controller.handle({ type: 'REPLY_CONFIRMED', payload: { jobId: job.id, token: job.token } }, sender);
  const result = await env.controller.handle({ type: 'AUTOMATION_CONTROL', action: 'skip', jobId: job.id }, {});
  assert.equal(result.accepted, false);
  assert.equal((await env.status()).activeJob.tweetId, '2');
});

test('unresponsive notification pages respect the refresh cooldown', async () => {
  const env = environment(); env.setHealthReady(false);
  await env.controller.pulse(); env.advance(60_000); await env.controller.pulse();
  assert.equal(env.events.filter(event => event[0] === 'reload').length, 1);
});

test('browser-session ID reuse never navigates an unrelated tab', async () => {
  const env = environment(); await env.request(1);
  const studio = [...env.tabs.values()].find(tab => tab.url.includes('/snapshot/'));
  const unrelatedUrl = 'https://x.com/someone/status/555';
  env.tabs.get(studio.id).url = unrelatedUrl;
  env.advance(240_000); await env.browserRestart().pulse(true);
  env.advance(61_000); await env.controller.pulse();
  assert.equal(env.tabs.get(studio.id).url, unrelatedUrl);
  assert.equal([...env.tabs.values()].filter(tab => tab.url.includes('/snapshot/')).length, 1);
});

test('switching Studio sites across a browser restart reuses the owned Studio tab', async () => {
  const env = environment(); const { job, sender } = await makeReplyReady(env);
  await env.controller.handle({ type: 'CLAIM_REPLY', payload: { jobId: job.id, token: job.token } }, sender);
  await env.controller.handle({ type: 'REPLY_CONFIRMED', payload: { jobId: job.id, token: job.token } }, sender);
  env.settings.studioUrl = 'https://production.example.com';
  await env.browserRestart().pulse(true); await env.request(2);
  assert.equal(env.tabs.size, 3);
});
