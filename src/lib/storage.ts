export interface ExtensionSettings {
  orchestratorUrl: string;
  apiKey: string;
  autoReply: boolean;
  orbitorCuration: boolean;
  targetHandles: string[];
  selectedTheme: string;
  selectedAspect: string;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  orchestratorUrl: 'http://localhost:3000',
  apiKey: '',
  autoReply: false,
  orbitorCuration: false,
  targetHandles: ['monkeys'],
  selectedTheme: 'material',
  selectedAspect: '1080x1080',
};

const IS_EXTENSION = typeof chrome !== 'undefined' && chrome.storage !== undefined;

export async function getSettings(): Promise<ExtensionSettings> {
  if (IS_EXTENSION) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
        resolve(items as ExtensionSettings);
      });
    });
  } else {
    const local = localStorage.getItem('monkeys_x_extension_settings');
    if (local) {
      try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(local) };
      } catch {
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  const updated = { ...current, ...settings };

  if (IS_EXTENSION) {
    return new Promise((resolve) => {
      chrome.storage.sync.set(updated, () => {
        resolve();
      });
    });
  } else {
    localStorage.setItem('monkeys_x_extension_settings', JSON.stringify(updated));
  }
}
