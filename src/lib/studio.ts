// Chrome match patterns omit ports; the automator also checks the exact origin.
export function studioMatchPattern(studioUrl: string, path = '/*'): string {
  const url = new URL(studioUrl);
  return `${url.protocol}//${url.hostname}${path}`;
}

let configuration: Promise<void> = Promise.resolve();

export function configureStudioScripts(studioUrl: string): Promise<void> {
  configuration = configuration.catch(() => {}).then(async () => {
    if (!await chrome.permissions.contains({ origins: [studioMatchPattern(studioUrl)] })) {
      throw new Error('Allow access to the Studio URL in extension Settings first.');
    }
    const matches = [studioMatchPattern(studioUrl, '/snapshot/*')];
    const scripts: chrome.scripting.RegisteredContentScript[] = [
      { id: 'monkeys-studio-interceptor', matches, js: ['injected-interceptor.js'], world: 'MAIN', runAt: 'document_start' },
      { id: 'monkeys-studio-automator', matches, js: ['snapshot-automator.js'], runAt: 'document_idle' },
    ];
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: scripts.map(script => script.id) });
    const existingIds = new Set(existing.map(script => script.id));
    const updates = scripts.filter(script => existingIds.has(script.id));
    const additions = scripts.filter(script => !existingIds.has(script.id));
    if (updates.length) await chrome.scripting.updateContentScripts(updates);
    if (additions.length) await chrome.scripting.registerContentScripts(additions);
  });
  return configuration;
}
