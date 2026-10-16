import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModule } from './harness.mjs';

const parser = loadModule('src/lib/screenshot-request.ts');
const parse = text => parser.parseScreenshotRequest(text, 'monkeys_com_co');

test('natural screenshot aliases and polite requests select the current post', () => {
  for (const text of [
    'Hey @monkeys_com_co screenshot this',
    '@monkeys_com_co snapshot this',
    'Can you snap this, @monkeys_com_co?',
    '@monkeys_com_co please take a screen shot of this post for me, thanks!',
    '@monkeys_com_co could you capture the current tweet?',
    '@monkeys_com_co screengrab this please',
    'Snapshot this @monkeys_com_co please!',
    '@monkeys_com_co grab a screenshot of this pls',
    'My actual post content. @monkeys_com_co screenshot this',
  ]) assert.equal(parse(text)?.target, 'current', text);
});

test('notification watcher ignores uncertain requests and does not infer a parent from other links', async () => {
  const messages = [];
  let scan;
  const article = (id, text, parentId, quoteOnly = false) => {
    const element = {
    parentId,
    textContent: text + ' @monkeys_com_co screenshot this (quoted content)',
    getAttribute: name => name === 'data-in-reply-to-status-id' ? element.parentId ?? null : null,
    querySelector: () => timestamp,
    querySelectorAll: selector => selector === 'time' ? [timestamp] : selector === '[data-testid="tweetText"]' ? [
      { closest: () => null, cloneNode: () => ({ textContent: text, querySelectorAll: () => [] }) },
      { closest: () => ({}), textContent: '@monkeys_com_co screenshot this' },
    ] : [{ getAttribute: () => '/quoted/status/999' }],
    };
    const permalink = { getAttribute: () => `/requester/status/${quoteOnly ? '999' : id}`,
      parentElement: { closest: () => quoteOnly ? {} : null } };
    const timestamp = { closest: selector => selector === 'article' ? element
      : selector === '[data-testid="quoteTweet"]' ? null : permalink };
    return element;
  };
  const articles = [
    article('101', '@monkeys_com_co snapshot this', '999'),
    article('102', '@monkeys_com_co screenshot above'),
    article('103', '@monkeys_com_co screenshot above', '888'),
    article('104', "@monkeys_com_co don't screenshot this"),
    article('105', '@monkeys_com_co save this'),
    article('106', 'This is ordinary post text'),
    article('107', '@monkeys_com_co screenshot this and above'),
    article('108', '@monkeys_com_co snapshot https://x.com/author/status/555'),
    article('109', '@monkeys_com_co snapshot this', undefined, true),
  ];
  loadModule('src/content/notifications-watcher.ts', {
    document: { body: {}, querySelector: () => null, querySelectorAll: () => articles },
    location: { pathname: '/notifications' },
    MutationObserver: class { observe() {} },
    chrome: {
      runtime: { onMessage: { addListener: listener => { scan = listener; } }, sendMessage: async message => { messages.push(message); return { accepted: true }; } },
      storage: { onChanged: { addListener() {} }, sync: { get: async () => ({ xUsername: 'monkeys_com_co' }) } },
    },
  });
  await new Promise(setImmediate);
  assert.deepEqual(messages.filter(message => message.type === 'MENTION_DETECTED').map(message => [message.payload.tweetId, message.payload.tweetUrl]), [
    ['101', 'https://x.com/requester/status/101'],
    ['103', 'https://x.com/i/status/888'],
    ['108', 'https://x.com/author/status/555'],
  ]);
  // Late relationship metadata must remain eligible; a diagnostic is not an acknowledgement.
  articles[1].parentId = '777';
  scan({ type: 'SCAN_NOTIFICATIONS' }, {}, () => {});
  await new Promise(setImmediate);
  const mentions = messages.filter(message => message.type === 'MENTION_DETECTED');
  assert.equal(mentions.at(-1).payload.tweetId, '102');
  assert.equal(mentions.at(-1).payload.tweetUrl, 'https://x.com/i/status/777');
});

test('above, parent and previous identify a parent request without assuming a target URL', () => {
  for (const text of [
    '@monkeys_com_co screenshot above',
    '@monkeys_com_co capture the post above',
    'Please snapshot the previous tweet @monkeys_com_co',
    '@monkeys_com_co take a screenshot of the parent post',
  ]) assert.equal(parse(text)?.target, 'parent', text);
});

test('one explicit X post URL identifies that exact post and strips tracking parameters', () => {
  for (const text of [
    '@monkeys_com_co screenshot https://x.com/alice/status/123?s=20',
    '@monkeys_com_co snapshot this https://twitter.com/alice/status/123.',
    '@monkeys_com_co capture this post: https://x.com/alice/status/123',
  ]) {
    assert.equal(parse(text)?.target, 'url', text);
    assert.match(parse(text)?.url ?? '', /^https:\/\/(x|twitter)\.com\/alice\/status\/123$/);
  }
});

test('unknown, ambiguous, quoted, conditional and negated requests do nothing', () => {
  for (const text of [
    '@monkeys_com_co screenshot', '@monkeys_com_co save this',
    '@monkeys_com_co screenshot that', '@monkeys_com_co screenshot the original thread',
    '@monkeys_com_co screenshot this and above', '@monkeys_com_co snapshot this or the parent',
    '@monkeys_com_co screenshot this in the light theme',
    "@monkeys_com_co don't screenshot this", '@monkeys_com_co do not snapshot this',
    '@monkeys_com_co never capture the above post', '@monkeys_com_co maybe screenshot this',
    '@monkeys_com_co if possible screenshot this', '@monkeys_com_co can you explain how to screenshot this?',
    '@monkeys_com_co this screenshot looks great',
    'Someone said "@monkeys_com_co screenshot this"',
    '@monkeys_com_co `screenshot this`', '@monkeys_com_co screenshot this; then delete it',
    '@monkeys_com_co screenshot this https://example.com/post/123',
    '@monkeys_com_co screenshot https://x.com/a/status/1 https://x.com/b/status/2',
    '@monkeys_com_co snapshot this https://x.com.evil.test/a/status/1',
    "Don't @monkeys_com_co screenshot this", 'What if @monkeys_com_co snapshot this',
    'She said @monkeys_com_co screenshot this', '"@monkeys_com_co screenshot this',
    '@monkeys_com_co screenshot this "only if it is public"',
    '@monkeys_com_co screenshot this `in the light theme`',
    '@monkeys_com_co screenshot this "and above"',
  ]) assert.equal(parse(text), null, text);
});

test('only the configured exact account can receive a command', () => {
  assert.equal(parse('@monkeys_com_co_extra snapshot this'), null);
  assert.equal(parse('email@monkeys_com_co screenshot this'), null);
  assert.equal(parse('@somebody_else snapshot this'), null);
  assert.equal(parser.parseScreenshotRequest('@OTHER_BOT snapshot this', '@other_bot')?.target, 'current');
});

test('current selection never switches to a parent and unverified parents are ignored', () => {
  const currentUrl = 'https://x.com/requester/status/123';
  assert.equal(parser.resolveScreenshotRequest({ target: 'current' }, { currentUrl, parentId: '999' }), currentUrl);
  assert.equal(parser.resolveScreenshotRequest({ target: 'parent' }, { currentUrl }), null);
  assert.equal(parser.resolveScreenshotRequest({ target: 'parent' }, { currentUrl, parentId: '999' }), 'https://x.com/i/status/999');
  assert.equal(parser.resolveScreenshotRequest({ target: 'parent' }, { currentUrl, parentId: '123' }), null);
});
