import { getSettings, DEFAULT_SETTINGS } from '../lib/storage';
import { createJob } from '../lib/api';

// Initialize settings on installation
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Monkeys X Automation Extension Installed.');
  const existingSettings = await getSettings();
  // Ensure default values are populated if empty
  if (!existingSettings.orchestratorUrl) {
    await chrome.storage.sync.set(DEFAULT_SETTINGS);
  }
});

// Handle incoming runtime messages from content script or popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CREATE_AUTOMATION_JOB') {
    const { tweetId, replyToTweetId } = message.payload;
    
    // Asynchronous message reply execution
    (async () => {
      try {
        const settings = await getSettings();
        const job = await createJob(settings, tweetId, replyToTweetId);
        sendResponse({ success: true, job });
      } catch (error: any) {
        console.error('Error in background job creation:', error);
        sendResponse({ success: false, error: error.message || 'Failed to create job.' });
      }
    })();

    return true; // Keep message channel open for asynchronous sendResponse
  }
  
  return false;
});
