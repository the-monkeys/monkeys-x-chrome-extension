import { getSettings } from '../lib/storage';
import { createJob } from '../lib/api';
import { configureStudioScripts } from '../lib/studio';
import { AutomationController } from './automation';

const controller = new AutomationController();
const ALARM = 'monkeys-automation-health';
const report = (error: unknown) => console.error('[Monkeys] Automation error:', error);

async function initialize(browserRestart = false) {
  await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  await controller.pulse(browserRestart);
}

chrome.runtime.onInstalled.addListener(() => { void initialize().catch(report); });
chrome.runtime.onStartup.addListener(() => { void initialize(true).catch(report); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) void controller.pulse().catch(report);
});
chrome.tabs.onRemoved.addListener(tabId => { void controller.tabRemoved(tabId).catch(report); });
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'complete') void controller.tabReady(tabId).catch(report);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const respond = async () => {
    if (message.type === 'CONFIGURE_STUDIO') {
      await configureStudioScripts((await getSettings()).studioUrl);
      await controller.pulse();
      return { success: true };
    }
    if (message.type === 'CREATE_AUTOMATION_JOB') {
      const job = await createJob(await getSettings(), message.payload.tweetId, message.payload.replyToTweetId);
      return { success: true, job };
    }
    return controller.handle(message, sender);
  };
  void respond().then(sendResponse, error => {
    report(error);
    sendResponse({ success: false, accepted: false, error: error instanceof Error ? error.message : 'Automation failed.' });
  });
  return true;
});

// Recreate alarms after an update/reload without a permanently running worker.
void chrome.alarms.get(ALARM).then(alarm => {
  if (!alarm) return chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}).catch(report);
