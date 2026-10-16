export interface ExtensionSettings {
  xUsername: string;
  studioUrl: string;
  orchestratorUrl: string;
  apiKey: string;
  autoReply: boolean;
  keepAwake: boolean;
  orbitorCuration: boolean;
  targetHandles: string[];
  selectedTheme: string;
  selectedAspect: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  xUsername: 'monkeys_com_co',
  studioUrl: 'https://incredible-eclair-ada155.netlify.app',
  orchestratorUrl: 'http://localhost:3000',
  apiKey: '',
  autoReply: false,
  keepAwake: true,
  orbitorCuration: false,
  targetHandles: ['monkeys_com_co'],
  selectedTheme: 'midnight',
  selectedAspect: '1080x1080',
};

const IS_EXTENSION = typeof chrome !== 'undefined' && chrome.storage !== undefined;

export function normalizeSettings(settings: ExtensionSettings): ExtensionSettings {
  const xUsername = settings.xUsername.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(xUsername)) {
    throw new Error('Enter an X username with 1–15 letters, numbers, or underscores.');
  }
  let studio: URL;
  try {
    studio = new URL(settings.studioUrl.trim());
  } catch {
    throw new Error('Enter a valid Studio website URL.');
  }
  if (!['https:', 'http:'].includes(studio.protocol) || studio.username || studio.password) {
    throw new Error('Studio URL must use HTTP or HTTPS without embedded credentials.');
  }
  return { ...settings, xUsername, studioUrl: studio.origin, targetHandles: [xUsername], selectedTheme: 'midnight' };
}

export async function getSettings(): Promise<ExtensionSettings> {
  if (IS_EXTENSION) {
    const settings = await new Promise<ExtensionSettings>((resolve, reject) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(items as ExtensionSettings);
      });
    });
    return normalizeSettings(settings);
  } else {
    const local = localStorage.getItem('monkeys_x_extension_settings');
    if (local) {
      try {
        return normalizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(local) });
      } catch {
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  const updated = normalizeSettings({ ...current, ...settings });

  if (IS_EXTENSION) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set(updated, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  } else {
    localStorage.setItem('monkeys_x_extension_settings', JSON.stringify(updated));
  }
}
