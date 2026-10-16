import React, { useState, useEffect } from 'react';
import {
  Settings as SettingsIcon,
  Layers,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Save,
  MessageSquare
} from 'lucide-react';
import { getSettings, saveSettings, normalizeSettings, ExtensionSettings } from '../lib/storage';
import { studioMatchPattern } from '../lib/studio';
import type { AutomationStatus } from '../background/automation';
const BUILD_ID = typeof __MONKEYS_BUILD_ID__ === 'string' ? __MONKEYS_BUILD_ID__ : 'development';

interface MentionEvent {
  tweetId: string;
  detectedAt: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard');
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [mentions, setMentions] = useState<MentionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automation, setAutomation] = useState<AutomationStatus | null>(null);
  const [controlling, setControlling] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const s = await getSettings();
        setSettings(s);
        const stored = await chrome.storage.local.get('monkeys_recent_mentions');
        setMentions(stored.monkeys_recent_mentions ?? []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  useEffect(() => {
    const refresh = async () => {
      try {
        const status = await chrome.runtime.sendMessage({ type: 'GET_AUTOMATION_STATUS' });
        if (typeof status?.enabled === 'boolean') setAutomation(status);
      } catch { /* popup may be open during an extension reload */ }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, []);

  const control = async (action: string) => {
    setControlling(true);
    try {
      const result = await chrome.runtime.sendMessage({ type: 'AUTOMATION_CONTROL', action, jobId: automation?.activeJob?.id });
      if (!result?.accepted) throw new Error(result?.error || 'This action is no longer available. Refresh the popup.');
      setAutomation(result.status);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Could not update automation.', type: 'error' });
    } finally { setControlling(false); }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const updated = normalizeSettings(settings);
      const granted = await chrome.permissions.request({ origins: [studioMatchPattern(updated.studioUrl)] });
      if (!granted) throw new Error('Allow access to the Studio site to save this URL.');
      await saveSettings(updated);
      setSettings(updated);
      const response = await chrome.runtime.sendMessage({ type: 'CONFIGURE_STUDIO' });
      if (!response?.success) throw new Error(response?.error || 'Unable to configure the Studio site.');
      setMessage({ text: 'Settings saved', type: 'success' });
      setTimeout(() => setMessage(null), 3000);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : 'Failed to save', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const downloadDiagnostics = async () => {
    try {
      const report = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' });
      if (!report?.events || !report?.buildId) throw new Error('Diagnostics unavailable. Reload the extension first.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'monkeys-diagnostics.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage({ type: 'success', text: 'Diagnostics downloaded. You can attach that JSON file to this chat.' });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Could not download diagnostics.' });
    }
  };

  if (loading) {
    return (
      <div className="popup-container" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <RefreshCw className="spinning" style={{ color: '#8b5cf6', width: 24, height: 24 }} />
      </div>
    );
  }

  return (
    <div className="popup-container">
      <header className="header">
        <div className="logo-container">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="url(#g)"/>
            <defs><linearGradient id="g" x1="0" y1="0" x2="24" y2="24"><stop stopColor="#8b5cf6"/><stop offset="1" stopColor="#f97316"/></linearGradient></defs>
          </svg>
          <span className="logo-text">MONKEYS X</span>
        </div>
      </header>

      <nav className="tabs-navigation">
        <button
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <Layers size={14} /><span>Mentions</span>
        </button>
        <button
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <SettingsIcon size={14} /><span>Settings</span>
        </button>
      </nav>

      <main className="tab-content">
        {activeTab === 'dashboard' ? (
          <>
            {automation && (
              <section className="automation-panel" aria-label="Automation status">
                <div className="dashboard-actions">
                  <span className="section-title">{automation.enabled ? 'Monitoring' : 'Paused'}</span>
                  <button className="action-btn-sm" disabled={controlling} onClick={() => { void control(automation.enabled ? 'pause' : 'start'); }}>
                    {automation.enabled ? 'Pause' : 'Start monitoring'}
                  </button>
                </div>
                <span>{automation.pendingCount} / {automation.queueLimit} requests · {automation.managedTabs} / 3 managed tabs</span>
                <span className="toggle-desc">Health check: {automation.lastCheckAt ? new Date(automation.lastCheckAt).toLocaleTimeString() : 'Waiting for first check'}</span>
                {automation.warning && <p className="automation-warning" role="status">{automation.warning}</p>}
                {automation.activeJob && <>
                  <span>Request …{automation.activeJob.tweetId.slice(-6)}: {automation.activeJob.stage.replace(/_/g, ' ')} (attempt {automation.activeJob.attempts}/3)</span>
                  <a className="tweet-link" href={automation.activeJob.tweetUrl} target="_blank" rel="noreferrer">
                    Screenshot target: {automation.activeJob.targetKind === 'parent' ? 'parent post' : automation.activeJob.targetKind === 'current' ? 'command post' : 'selected post'} <ExternalLink size={10} />
                  </a>
                  {automation.activeJob.stage === 'retry_wait' && automation.activeJob.retryAt && <span className="toggle-desc">
                    Next retry: {new Date(automation.activeJob.retryAt).toLocaleTimeString()}{!automation.enabled ? ' — paused' : ''}
                  </span>}
                  {automation.activeJob.error && <p className="automation-warning">{automation.activeJob.error}</p>}
                  {automation.activeJob.stage === 'awaiting_approval' && (
                    <button className="action-btn-sm" disabled={controlling || !automation.enabled} onClick={() => { void control('approve'); }}>Approve screenshot reply</button>
                  )}
                  {automation.activeJob.stage === 'needs_review' && <>
                    <a className="tweet-link" href={`https://x.com/i/status/${automation.activeJob.reviewTweetId ?? automation.activeJob.tweetId}`} target="_blank" rel="noreferrer">Check reply on X <ExternalLink size={10} /></a>
                    <button className="action-btn-sm" disabled={controlling} onClick={() => { void control('resolve_posted'); }}>I checked X — mark posted</button>
                  </>}
                  {automation.activeJob.stage !== 'posting' && (
                    <button className="refresh-btn skip-request" disabled={controlling} onClick={() => { void control('skip'); }}>Skip this request</button>
                  )}
                </>}
              </section>
            )}
            <details className="diagnostics-panel">
              <summary>Diagnostics · v1.0.2</summary>
              <span>Popup build: {BUILD_ID}</span>
              <span>Worker build: {automation?.buildId ?? 'not connected'}</span>
              {['watcher', 'studio', 'reply'].map(component => {
                const script = automation?.scriptVersions?.slice().reverse().find(item => item.component === component);
                return <span key={component} className={script && script.buildId !== BUILD_ID ? 'automation-warning' : ''}>
                  {component}: {script ? `${script.buildId} (tab ${script.tabId})${script.buildId !== BUILD_ID ? ' — refresh required' : ''}` : 'not seen yet'}
                </span>;
              })}
              <span>Latest step: {automation?.lastTrace ?? 'waiting for activity'}</span>
              <button className="action-btn-sm" onClick={() => { void downloadDiagnostics(); }}>Download diagnostics</button>
              <span className="toggle-desc">Last 300 events, saved locally. No image data, cookies or API keys.</span>
            </details>
            {message && <div className={`toast ${message.type}`} role="status">{message.text}</div>}
            <div className="dashboard-actions">
              <span className="section-title">Recent @{settings?.xUsername} Mentions</span>
              <button
                className="refresh-btn"
                onClick={async () => {
                  const stored = await chrome.storage.local.get('monkeys_recent_mentions');
                  setMentions(stored.monkeys_recent_mentions ?? []);
                }}
                title="Refresh"
              >
                <RefreshCw size={14} />
              </button>
            </div>

            {mentions.length === 0 ? (
              <div className="empty-state">
                <MessageSquare size={32} />
                <p style={{ fontSize: 13, fontWeight: 600 }}>No Mentions Yet</p>
                <p style={{ fontSize: 11, color: '#94a3b8' }}>
                  Keep a tab open on x.com/notifications. When someone tags @{settings?.xUsername}, it will appear here.
                </p>
              </div>
            ) : (
              <div className="jobs-list">
                {mentions.map((m, i) => {
                  const job = automation?.jobs.find(item => item.tweetId === m.tweetId && item.account === settings?.xUsername);
                  return (
                  <div className="job-card" key={i}>
                    <div className="job-header">
                      <span className="job-type-badge">MENTION</span>
                      <span className="job-time">{new Date(m.detectedAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="job-details">
                      <a
                        href={`https://x.com/i/status/${m.tweetId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="tweet-link"
                      >
                        Tweet ...{m.tweetId.slice(-6)}
                        <ExternalLink size={10} />
                      </a>
                    </div>
                    {job && <div className="toggle-desc">{job.stage.replace(/_/g, ' ')}{job.error ? `: ${job.error}` : ''}</div>}
                  </div>
                  );
                })}
              </div>
            )}
          </>
        ) : settings ? (
          <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="x-username">X username</label>
              <input
                id="x-username"
                className="form-input"
                value={settings.xUsername}
                onChange={e => setSettings({ ...settings, xUsername: e.target.value })}
                placeholder="@monkeys_com_co"
                required
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="studio-url">Studio URL</label>
              <input
                id="studio-url"
                type="url"
                className="form-input"
                value={settings.studioUrl}
                onChange={e => setSettings({ ...settings, studioUrl: e.target.value })}
                placeholder="https://incredible-eclair-ada155.netlify.app"
                required
              />
              <span className="toggle-desc">Website base URL. Screenshot theme: Midnight.</span>
            </div>
            <div className="form-group">
              <label className="form-label">Orchestrator URL</label>
              <input
                type="url"
                className="form-input"
                value={settings.orchestratorUrl}
                onChange={e => setSettings({ ...settings, orchestratorUrl: e.target.value })}
                placeholder="http://localhost:3000"
              />
            </div>
            <div className="form-group">
              <label className="form-label">API Key</label>
              <input
                type="password"
                className="form-input"
                value={settings.apiKey}
                onChange={e => setSettings({ ...settings, apiKey: e.target.value })}
              />
            </div>
            <div className="toggle-group">
              <div className="toggle-info">
                <span className="toggle-title">Auto Reply on Mention</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={settings.autoReply}
                  onChange={e => setSettings({ ...settings, autoReply: e.target.checked })}
                />
                <span className="slider"></span>
              </label>
            </div>
            <div className="toggle-group">
              <div className="toggle-info">
                <span className="toggle-title">Keep laptop awake</span>
                <span className="toggle-desc">While monitoring. The display can turn off.</span>
              </div>
              <label className="switch">
                <input type="checkbox" aria-label="Keep laptop awake" checked={settings.keepAwake}
                  onChange={e => setSettings({ ...settings, keepAwake: e.target.checked })} />
                <span className="slider"></span>
              </label>
            </div>
            <button className="submit-btn" type="submit" disabled={saving}>
              {saving ? (
                <><RefreshCw className="spinning" size={14} /><span>Saving...</span></>
              ) : (
                <><Save size={14} /><span>Save Settings</span></>
              )}
            </button>
            {message && (
              <div className={`toast ${message.type}`}>
                {message.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                <span>{message.text}</span>
              </div>
            )}
          </form>
        ) : null}
      </main>

      <footer className="footer">
        <span>v1.0.2 · background export</span>
        <span>Queue & recovery</span>
      </footer>
    </div>
  );
}
