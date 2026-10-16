export type ScreenshotRequest = { target: 'current' | 'parent' } | { target: 'url'; url: string };

export function canonicalPostUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https://x.com', 'https://twitter.com'].includes(url.origin) || url.username || url.password) return null;
    if (!/^\/(?:[a-z0-9_]{1,15}|i\/web)\/status\/\d+\/?$/i.test(url.pathname)) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

/** A small, deliberately conservative grammar, not general language inference.
 * Unknown text, conflicting targets and unsupported modifiers return null. */
export function parseScreenshotRequest(text: string, username: string): ScreenshotRequest | null {
  const account = username.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(account)) return null;
  // Never delete quoted/code modifiers: doing so could turn a conditional or
  // conflicting request into a different, apparently valid command.
  const source = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (/["“”\x60]/.test(source)) return null;
  const mentions = [...source.matchAll(new RegExp(`(^|[^a-z0-9_])@${account}(?![a-z0-9_])`, 'ig'))];
  if (mentions.length !== 1) return null;
  const mention = mentions[0];
  const start = mention.index! + mention[1].length;
  const before = source.slice(0, start).trim();
  const after = source.slice(start + account.length + 1).trim();
  if (/\b(?:don['’]?t|do not|never|not|no|stop|cancel|avoid|maybe|perhaps|if|unless|whether|why|said|says|wrote)\b/i.test(before)) return null;
  // Allow real post content before the bot mention. With a trailing mention,
  // require the preceding text itself to be a complete recognized request.
  const courtesyOnly = /^(?:(?:please|pls|thanks|thank you|for me|kindly)[\s,!?.]*)+$/i.test(after);
  let command = /[a-z0-9]/i.test(after) && !courtesyOnly ? after : `${before} ${after}`.trim();
  if (!command || /@\w+/.test(command)) return null;

  const urls = command.match(/https?:\/\/[^\s<>"\x60]+/gi) ?? [];
  if (urls.length > 1) return null;
  let explicitUrl: string | undefined;
  const urlToken = urls[0];
  if (urlToken) {
    explicitUrl = canonicalPostUrl(urlToken.replace(/[),.!?:;]+$/, '')) ?? undefined;
    if (!explicitUrl) return null;
    command = command.replace(urlToken, ' __post_url__ ');
  }
  command = command.toLowerCase().replace(/[,!?;:.]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Only these courtesy prefixes are optional. Negation, conditionals, questions
  // about commands, past-tense descriptions, etc. fail the full grammar below.
  command = command.replace(/^(?:(?:hey|hi|hello|please|pls|kindly|can you|could you|would you|will you|can u|could u)\s+)+/, '');
  const action = /^(?:(?:take|make|generate|create|grab|get)\s+(?:a\s+)?|(?:send|give)\s+me\s+(?:a\s+)?)?(?:screenshot|snapshot|snap|capture|screen[ -]?shot|screen[ -]?grab|screen[ -]?capture)\b\s*/.exec(command);
  if (!action) return null;
  const tail = command.slice(action[0].length);
  const target = /^(?:(?:of|for)\s+)?(?:the\s+)?(?:(?:post|tweet)\s+)?(this|current|above|parent|previous|__post_url__)(?:\s+(?:post|tweet|one|link))?\b/.exec(tail);
  if (!target) return null;
  let rest = tail.slice(target[0].length).trim();
  // A single URL may qualify "this post", but never a conflicting parent cue.
  if (explicitUrl && ['above', 'parent', 'previous'].includes(target[1])) return null;
  if (explicitUrl) rest = rest.replace(/^__post_url__\s*/, '');
  rest = rest.replace(/^(?:(?:please|pls|thanks|thank you|for me|kindly)\s*)+$/, '').trim();
  if (rest) return null;
  if (explicitUrl) return { target: 'url', url: explicitUrl };
  return { target: ['above', 'parent', 'previous'].includes(target[1]) ? 'parent' : 'current' };
}

export function resolveScreenshotRequest(request: ScreenshotRequest, context: { currentUrl: string; parentId?: string }): string | null {
  const current = canonicalPostUrl(context.currentUrl);
  if (!current) return null;
  if (request.target === 'url') return canonicalPostUrl(request.url);
  if (request.target === 'current') return current;
  const currentId = current.match(/\/status\/(\d+)$/)?.[1];
  if (!context.parentId || !/^\d+$/.test(context.parentId) || context.parentId === currentId) return null;
  return `https://x.com/i/status/${context.parentId}`;
}
