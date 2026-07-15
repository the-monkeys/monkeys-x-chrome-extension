import React, { useState, useEffect } from 'react';
import { 
  Settings as SettingsIcon, 
  Layers, 
  RefreshCw, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink,
  Save,
  XCircle,
  HelpCircle
} from 'lucide-react';
import { getSettings, saveSettings, ExtensionSettings } from '../lib/storage';
import { fetchJobs, approveJob, checkHealth, AutomationJob, HealthStatus } from '../lib/api';

export default function App() {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'settings'>('dashboard');
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  
  // UI states
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Load configuration on mount
  useEffect(() => {
    async function init() {
      try {
        const loadedSettings = await getSettings();
        setSettings(loadedSettings);
        await performHealthCheck(loadedSettings);
      } catch (err) {
        console.error('Initialization failed:', err);
      } finally {
        setLoading(false);
      }
    }
    init();
  }, []);

  // Poll for jobs when dashboard is active and backend is connected
  useEffect(() => {
    let interval: any;
    if (activeTab === 'dashboard' && settings && health?.xConnected) {
      loadJobs(settings);
      interval = setInterval(() => {
        loadJobs(settings, true);
      }, 8000); // Poll every 8s
    }
    return () => clearInterval(interval);
  }, [activeTab, settings, health]);

  const performHealthCheck = async (cfg: ExtensionSettings) => {
    if (!cfg.orchestratorUrl) {
      setHealth(null);
      return;
    }
    try {
      const status = await checkHealth(cfg);
      setHealth(status);
      if (status.xConnected) {
        loadJobs(cfg);
      }
    } catch (err) {
      console.warn('Orchestrator health check failed:', err);
      setHealth({ status: 'offline', xConnected: false, workerActive: false });
    }
  };

  const loadJobs = async (cfg: ExtensionSettings, silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const activeJobs = await fetchJobs(cfg);
      // Sort jobs to display newest first
      setJobs(activeJobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    } catch (err) {
      console.error('Failed to load jobs:', err);
    } finally {
      if (!silent) setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    if (!settings) return;
    setRefreshing(true);
    await performHealthCheck(settings);
    setRefreshing(false);
  };

  const handleApprove = async (jobId: string) => {
    if (!settings) return;
    try {
      await approveJob(settings, jobId);
      showStatusMessage('Job approved successfully!', 'success');
      loadJobs(settings);
    } catch (err: any) {
      showStatusMessage(err.message || 'Approval failed.', 'error');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setMessage(null);

    try {
      await saveSettings(settings);
      await performHealthCheck(settings);
      showStatusMessage('Settings saved successfully!', 'success');
    } catch (err: any) {
      showStatusMessage(err.message || 'Failed to save settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const showStatusMessage = (text: string, type: 'success' | 'error') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 3000);
  };

  const updateSettingField = <K extends keyof ExtensionSettings>(field: K, value: ExtensionSettings[K]) => {
    if (!settings) return;
    setSettings({
      ...settings,
      [field]: value
    });
  };

  if (loading) {
    return (
      <div className="popup-container" style={{ justifyContent: 'center', alignItems: 'center' }}>
        <RefreshCw className="spinning" style={{ color: '#8b5cf6', width: '24px', height: '24px' }} />
      </div>
    );
  }

  const isConnected = health && health.status !== 'offline';

  return (
    <div className="popup-container">
      {/* Header */}
      <header className="header">
        <div className="logo-container">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM12 6C13.66 6 15 7.34 15 9C15 10.66 13.66 12 12 12C10.34 12 9 10.66 9 9C9 7.34 10.34 6 12 6ZM12 18C9.33 18 4.67 19.33 4.67 22C5.97 23.23 7.73 24 9.67 24H14.33C16.27 24 18.03 23.23 19.33 22C19.33 19.33 14.67 18 12 18Z" fill="url(#logoGrad)"/>
            <defs>
              <linearGradient id="logoGrad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
                <stop stopColor="#8b5cf6" />
                <stop offset="1" stopColor="#f97316" />
              </linearGradient>
            </defs>
          </svg>
          <span className="logo-text">MONKEYS X</span>
        </div>

        <div className={`status-badge ${isConnected ? 'connected' : 'disconnected'}`}>
          <span className="status-dot"></span>
          <span>{isConnected ? 'Connected' : 'Offline'}</span>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="tabs-navigation">
        <button 
          className={`tab-btn ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <Layers size={14} />
          <span>Queue</span>
        </button>
        <button 
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <SettingsIcon size={14} />
          <span>Settings</span>
        </button>
      </nav>

      {/* Main Tab Contents */}
      <main className="tab-content">
        {activeTab === 'dashboard' ? (
          <>
            <div className="dashboard-actions">
              <span className="section-title">Active Automation Jobs</span>
              <button 
                className={`refresh-btn ${refreshing ? 'spinning' : ''}`}
                onClick={handleRefresh}
                title="Refresh queue"
                disabled={refreshing}
              >
                <RefreshCw size={14} />
              </button>
            </div>

            {!isConnected ? (
              <div className="empty-state">
                <XCircle size={32} style={{ color: '#ef4444' }} />
                <p style={{ fontSize: '13px', fontWeight: 600 }}>Orchestrator Offline</p>
                <p style={{ fontSize: '11px', color: '#94a3b8' }}>
                  Please verify your settings and check that your Monkeys backend orchestrator is running.
                </p>
              </div>
            ) : jobs.length === 0 ? (
              <div className="empty-state">
                <HelpCircle size={32} />
                <p style={{ fontSize: '13px', fontWeight: 600 }}>No Jobs Found</p>
                <p style={{ fontSize: '11px', color: '#94a3b8' }}>
                  Go to a tweet page on x.com and click the "Monkeys" button to trigger a screenshot job.
                </p>
              </div>
            ) : (
              <div className="jobs-list">
                {jobs.map((job) => (
                  <div className="job-card" key={job.id}>
                    <div className="job-header">
                      <span className="job-type-badge">
                        {job.type === 'mention_reply' ? 'Reply' : 'Curated'}
                      </span>
                      <span className={`job-status-pill ${job.status}`}>
                        {job.status}
                      </span>
                    </div>

                    <div className="job-details">
                      <a 
                        href={`https://x.com/i/status/${job.sourceTweetId}`} 
                        target="_blank" 
                        rel="noreferrer"
                        className="tweet-link"
                      >
                        <span>Tweet ID: ...{job.sourceTweetId.slice(-6)}</span>
                        <ExternalLink size={10} />
                      </a>
                      <span className="job-time">
                        {new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    {job.status === 'pending' && (
                      <div className="job-actions">
                        <button 
                          className="action-btn-sm"
                          onClick={() => handleApprove(job.id)}
                        >
                          Approve & Post
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          settings && (
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <div className="form-group">
                <label className="form-label">Orchestrator URL</label>
                <input 
                  type="url" 
                  className="form-input" 
                  value={settings.orchestratorUrl}
                  onChange={(e) => updateSettingField('orchestratorUrl', e.target.value)}
                  placeholder="http://localhost:3000"
                  required
                />
              </div>

              <div className="form-group">
                <label className="form-label">API Key / JWT</label>
                <input 
                  type="password" 
                  className="form-input" 
                  value={settings.apiKey}
                  onChange={(e) => updateSettingField('apiKey', e.target.value)}
                  placeholder="Paste Monkeys Token"
                />
              </div>

              <div className="toggle-group">
                <div className="toggle-info">
                  <span className="toggle-title">Auto Reply on Mention</span>
                  <span className="toggle-desc">Automatically screenshot and reply</span>
                </div>
                <label className="switch">
                  <input 
                    type="checkbox" 
                    checked={settings.autoReply}
                    onChange={(e) => updateSettingField('autoReply', e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
              </div>

              <div className="toggle-group">
                <div className="toggle-info">
                  <span className="toggle-title">Orbitor Curated Feed</span>
                  <span className="toggle-desc">Auto-schedule top curated posts</span>
                </div>
                <label className="switch">
                  <input 
                    type="checkbox" 
                    checked={settings.orbitorCuration}
                    onChange={(e) => updateSettingField('orbitorCuration', e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
              </div>

              <div className="form-group">
                <label className="form-label">Screenshot styling theme</label>
                <select 
                  className="form-select"
                  value={settings.selectedTheme}
                  onChange={(e) => updateSettingField('selectedTheme', e.target.value)}
                >
                  <option value="material">Material (Default)</option>
                  <option value="midnight">Midnight Dark</option>
                  <option value="aurora">Aurora Neon</option>
                  <option value="slate">Slate Modern</option>
                </select>
              </div>

              <button className="submit-btn" type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <RefreshCw className="spinning" size={14} />
                    <span>Saving...</span>
                  </>
                ) : (
                  <>
                    <Save size={14} />
                    <span>Save Configuration</span>
                  </>
                )}
              </button>

              {message && (
                <div className={`toast ${message.type}`}>
                  {message.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                  <span>{message.text}</span>
                </div>
              )}
            </form>
          )
        )}
      </main>

      {/* Footer */}
      <footer className="footer">
        <span>v1.0.0</span>
        <span>Monkeys X Automation</span>
      </footer>
    </div>
  );
}
