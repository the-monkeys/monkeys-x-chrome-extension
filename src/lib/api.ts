import { ExtensionSettings } from './storage';

export interface AutomationJob {
  id: string;
  type: 'mention_reply' | 'orbitor_post';
  sourceTweetId: string;
  replyToTweetId?: string;
  orbitorItemId?: string;
  options: {
    theme: string;
    aspect: string;
  };
  status: 'pending' | 'rendering' | 'posting' | 'posted' | 'failed' | 'skipped';
  xReplyTweetId?: string;
  error?: string;
  createdAt: string;
}

export interface HealthStatus {
  status: string;
  xConnected: boolean;
  workerActive: boolean;
}

async function request<T>(
  settings: ExtensionSettings,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: any
): Promise<T> {
  const url = `${settings.orchestratorUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (settings.apiKey) {
    headers['Authorization'] = `Bearer ${settings.apiKey}`;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Orchestrator error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchJobs(settings: ExtensionSettings): Promise<AutomationJob[]> {
  try {
    return await request<AutomationJob[]>(settings, '/api/x-automation/jobs');
  } catch (error) {
    console.error('Failed to fetch jobs:', error);
    throw error;
  }
}

export async function createJob(
  settings: ExtensionSettings,
  tweetId: string,
  replyToTweetId?: string
): Promise<AutomationJob> {
  return request<AutomationJob>(settings, '/api/x-automation/jobs', 'POST', {
    type: 'mention_reply',
    sourceTweetId: tweetId,
    replyToTweetId: replyToTweetId || tweetId,
    options: {
      theme: 'midnight',
      aspect: settings.selectedAspect,
    },
  });
}

export async function approveJob(settings: ExtensionSettings, jobId: string): Promise<void> {
  return request<void>(settings, `/api/x-automation/jobs/${jobId}/approve`, 'POST');
}

export async function checkHealth(settings: ExtensionSettings): Promise<HealthStatus> {
  return request<HealthStatus>(settings, '/api/x-automation/health', 'GET');
}
