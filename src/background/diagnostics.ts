export const BUILD_ID = typeof __MONKEYS_BUILD_ID__ === 'string' ? __MONKEYS_BUILD_ID__ : 'development';
export const DIAGNOSTICS_KEY = 'monkeys_automation_diagnostics';
export interface ScriptVersion { component: string; buildId: string; tabId?: number; seenAt: number }
export interface TraceEvent {
  at: number; component: string; event: string; buildId: string; tabId?: number;
  jobId?: string; stage?: string; attempt?: number;
  tokenPrefix?: string; stale?: boolean;
  details: Record<string, string | number | boolean | null>;
}
export interface Diagnostics { events: TraceEvent[]; scripts: ScriptVersion[] }
const fields = new Set(['targetUrl', 'targetId', 'targetKind', 'requestId', 'requestTextLength', 'reason', 'error',
  'editorCount', 'editorTextLength', 'captionLength', 'attachmentCount', 'fileInputs', 'fileBytes', 'fileType',
  'fileName', 'found', 'active', 'selectedTheme', 'inputUrl', 'previewId', 'previewTextLength', 'imageCharacters',
  'imageFormat', 'messageType', 'replyClicked', 'confirmed', 'accepted', 'retryAt', 'role', 'url', 'selector',
  'sourcePostId', 'responseStatus', 'textLength', 'mentionCount', 'leadingMentionCount', 'displayTextStart', 'bridgeVersion', 'visibilityState']);

/** Metadata only. Never retain message bodies, images, HTML, cookies or settings secrets. */
export function safeDetails(input: unknown): TraceEvent['details'] {
  const result: TraceEvent['details'] = {};
  if (!input || typeof input !== 'object') return result;
  for (const [key, value] of Object.entries(input)) {
    if (!fields.has(key)) continue;
    if (typeof value === 'string') {
      if (['url', 'targetUrl', 'inputUrl'].includes(key)) {
        try { const url = new URL(value); result[key] = url.origin + url.pathname; } catch { /* omit malformed URLs */ }
      } else result[key] = value.replace(/data:[^\s]+/gi, '[image omitted]').slice(0, 300);
    } else if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[key] = value;
  }
  return result;
}
