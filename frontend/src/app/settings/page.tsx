'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Settings, Save, Eye, EyeOff, RefreshCw, CheckCircle, AlertCircle, XCircle, HardDrive, Film, Tv, X, Plus, Sparkles, Shield, Gauge, Key, Download, RotateCcw } from 'lucide-react';

interface SettingsData {
  vpnUsername?: string;
  vpnPassword?: string;
  vpnRegion?: string;
  portForwarding?: string;
  downloadSpeedLimit?: string;
  uploadSpeedLimit?: string;
  speedLimitUnit?: string; // 'KB' or 'MB'
  omdbApiKey?: string;
  openrouterApiKey?: string;
  openrouterModel?: string;
  // Torrent search preferences (arrays for multi-select)
  preferredCodecs?: string[];
  preferredResolutions?: string[];
  preferredMovieGroups?: string[];
  // Legacy single-value settings (for backward compatibility)
  preferredCodec?: string;
  preferredResolution?: string;
  preferredMovieGroup?: string;
}

interface VpnStatus {
  configured: boolean;
  available: boolean;
  connected: boolean;
  message: string;
}

interface DiskInfo {
  name: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

interface VpnRegion {
  id: string;
  name: string;
  country: string;
  portForward: boolean;
}

// Common video codec options (suggestions)
const SUGGESTED_CODECS = [
  'x264',
  'x265',
  'HEVC',
  'AV1',
  'VP9',
];

// Common video resolution options (suggestions)
const SUGGESTED_RESOLUTIONS = [
  '480p',
  '720p',
  '1080p',
  '2160p',
  '4K',
];

// Common torrent release groups for movies (suggestions)
const SUGGESTED_GROUPS = [
  'yify',
  'yts',
  'galaxyrg',
  'ettv',
  'rarbg',
  'sparks',
  'ganool',
  'tigole',
  'qxr',
];

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-400"></div></div>}>
      <SettingsPageContent />
    </Suspense>
  );
}

function SettingsPageContent() {
  const searchParams = useSearchParams();
  const [settings, setSettings] = useState<SettingsData>({});
  const [vpnStatus, setVpnStatus] = useState<VpnStatus | null>(null);
  const [vpnRegions, setVpnRegions] = useState<VpnRegion[]>([]);
  const [regionsLoading, setRegionsLoading] = useState(true);
  const [disks, setDisks] = useState<DiskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  
  // Custom input states for preference fields
  const [customResolution, setCustomResolution] = useState('');
  const [customCodec, setCustomCodec] = useState('');
  const [customGroup, setCustomGroup] = useState('');
  
  // Sidebar: which section is active
  const [activeSection, setActiveSection] = useState('vpn');

  // AI dismissed recommendations
  const [aiTab, setAiTab] = useState<'settings' | 'dismissed'>('settings');
  const [dismissedKeys, setDismissedKeys] = useState<string[]>([]);
  const [dismissedLoading, setDismissedLoading] = useState(false);
  
  const sections = [
    { id: 'vpn', label: 'VPN', icon: Shield },
    { id: 'bandwidth', label: 'Bandwidth', icon: Gauge },
    { id: 'api', label: 'API Keys', icon: Key },
    { id: 'ai', label: 'AI', icon: Sparkles },
    { id: 'torrent', label: 'Torrents', icon: Download },
    { id: 'storage', label: 'Storage', icon: HardDrive },
  ];

  useEffect(() => {
    // Handle URL params for deep-linking (e.g. /settings?section=ai&tab=dismissed)
    const sectionParam = searchParams.get('section');
    const tabParam = searchParams.get('tab');
    if (sectionParam && sections.some(s => s.id === sectionParam)) {
      setActiveSection(sectionParam);
    }
    if (sectionParam === 'ai' && tabParam === 'dismissed') {
      setAiTab('dismissed');
      loadDismissed();
    }

    loadSettings();
    loadVpnStatus();
    loadVpnRegions();
    loadDiskStats();
    
    // Refresh VPN status periodically
    const interval = setInterval(loadVpnStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadVpnRegions = async () => {
    try {
      setRegionsLoading(true);
      const regions = await api.getVpnRegions();
      setVpnRegions(regions);
    } catch (error) {
      console.error('Failed to load VPN regions:', error);
      // Set fallback regions
      setVpnRegions([
        { id: 'nl_amsterdam', name: 'Netherlands', country: 'NL', portForward: true },
        { id: 'swiss', name: 'Switzerland', country: 'CH', portForward: true },
        { id: 'de-frankfurt', name: 'DE Frankfurt', country: 'DE', portForward: true },
      ]);
    } finally {
      setRegionsLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const data = await api.getSettings();
      
      // Parse JSON array settings
      const parsedData = { ...data };
      
      // Parse preferredCodecs
      if (data.preferredCodecs) {
        try {
          parsedData.preferredCodecs = typeof data.preferredCodecs === 'string' 
            ? JSON.parse(data.preferredCodecs) 
            : data.preferredCodecs;
        } catch {
          parsedData.preferredCodecs = data.preferredCodec ? [data.preferredCodec] : ['x264'];
        }
      } else if (data.preferredCodec) {
        parsedData.preferredCodecs = [data.preferredCodec];
      } else {
        parsedData.preferredCodecs = ['x264'];
      }
      
      // Parse preferredResolutions
      if (data.preferredResolutions) {
        try {
          parsedData.preferredResolutions = typeof data.preferredResolutions === 'string'
            ? JSON.parse(data.preferredResolutions)
            : data.preferredResolutions;
        } catch {
          parsedData.preferredResolutions = data.preferredResolution ? [data.preferredResolution] : ['720p', '1080p'];
        }
      } else if (data.preferredResolution) {
        parsedData.preferredResolutions = [data.preferredResolution];
      } else {
        parsedData.preferredResolutions = ['720p', '1080p'];
      }
      
      // Parse preferredMovieGroups
      if (data.preferredMovieGroups) {
        try {
          parsedData.preferredMovieGroups = typeof data.preferredMovieGroups === 'string'
            ? JSON.parse(data.preferredMovieGroups)
            : data.preferredMovieGroups;
        } catch {
          parsedData.preferredMovieGroups = data.preferredMovieGroup ? [data.preferredMovieGroup] : ['yify', 'yts', 'galaxyrg', 'ettv', 'rarbg'];
        }
      } else if (data.preferredMovieGroup) {
        parsedData.preferredMovieGroups = [data.preferredMovieGroup];
      } else {
        parsedData.preferredMovieGroups = ['yify', 'yts', 'galaxyrg', 'ettv', 'rarbg'];
      }
      
      setSettings(parsedData);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadVpnStatus = async () => {
    try {
      const status = await api.getVpnStatus();
      setVpnStatus(status);
    } catch (error) {
      console.error('Failed to load VPN status:', error);
    }
  };

  const loadDiskStats = async () => {
    try {
      const data = await api.getDiskStats();
      setDisks(data.disks || []);
    } catch (error) {
      console.error('Failed to load disk stats:', error);
    }
  };

  const loadDismissed = async () => {
    setDismissedLoading(true);
    try {
      const data = await api.getDismissedRecommendations();
      setDismissedKeys(data.dismissed || []);
    } catch {}
    setDismissedLoading(false);
  };

  const handleRestore = async (key: string) => {
    const parts = key.match(/^(.+)-(\d+)$/);
    if (!parts) return;
    try {
      await api.restoreRecommendation(parts[1], parseInt(parts[2]));
      setDismissedKeys(prev => prev.filter(k => k !== key));
    } catch {}
  };

  const handleRestoreAll = async () => {
    try {
      await api.restoreAllRecommendations();
      setDismissedKeys([]);
    } catch {}
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getUsageColor = (percent: number): string => {
    if (percent >= 90) return 'bg-red-500';
    if (percent >= 75) return 'bg-yellow-500';
    return 'bg-primary-500';
  };

  const saveSettings = async () => {
    setSaving(true);
    setMessage(null);
    
    try {
      // Filter out undefined values and convert to Record<string, string>
      const settingsToSave: Record<string, string> = {};
      for (const [key, value] of Object.entries(settings)) {
        if (value !== undefined) {
          // Serialize arrays as JSON strings
          if (Array.isArray(value)) {
            settingsToSave[key] = JSON.stringify(value);
          } else {
            settingsToSave[key] = value;
          }
        }
      }
      await api.updateSettings(settingsToSave);
      setMessage({ type: 'success', text: 'Settings saved successfully!' });
      
      // Refresh VPN status after saving
      setTimeout(loadVpnStatus, 1000);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setMessage({ type: 'error', text: 'Failed to save settings' });
    } finally {
      setSaving(false);
    }
  };

  const restartVpn = async () => {
    setRestarting(true);
    setMessage(null);
    
    try {
      // First save the VPN-related settings to the database
      const vpnSettings: Record<string, string> = {};
      if (settings.vpnUsername) vpnSettings.vpnUsername = settings.vpnUsername;
      if (settings.vpnPassword) vpnSettings.vpnPassword = settings.vpnPassword;
      if (settings.vpnRegion) vpnSettings.vpnRegion = settings.vpnRegion;
      if (settings.portForwarding !== undefined) vpnSettings.portForwarding = settings.portForwarding;
      
      await api.updateSettings(vpnSettings);
      
      // Now restart the VPN container
      const result = await api.restartVpn();
      if (result.success) {
        setMessage({ 
          type: 'success', 
          text: result.message || 'VPN restart initiated. QBittorrent should become available shortly.'
        });
        
        // Start polling for VPN status more frequently
        const checkVpn = async () => {
          await loadVpnStatus();
          if (vpnStatus?.available) {
            setMessage({ type: 'success', text: 'QBittorrent is now available!' });
          }
        };
        
        // Poll every 5 seconds for up to 2 minutes
        let attempts = 0;
        const pollInterval = setInterval(async () => {
          attempts++;
          await checkVpn();
          if (vpnStatus?.available || attempts >= 24) {
            clearInterval(pollInterval);
          }
        }, 5000);
      } else {
        setMessage({ type: 'error', text: result.message || 'Failed to restart VPN' });
      }
    } catch (error) {
      console.error('Failed to restart VPN:', error);
      setMessage({ type: 'error', text: 'Failed to restart VPN' });
    } finally {
      setRestarting(false);
    }
  };

  const updateSetting = (key: keyof SettingsData, value: string) => {
    // Convert speed values when switching units
    if (key === 'speedLimitUnit') {
      const oldUnit = settings.speedLimitUnit || 'MB';
      const newUnit = value;
      if (oldUnit !== newUnit) {
        const dl = parseFloat(settings.downloadSpeedLimit || '0');
        const ul = parseFloat(settings.uploadSpeedLimit || '0');
        let newDl: number, newUl: number;
        if (oldUnit === 'MB' && newUnit === 'KB') {
          newDl = Math.round(dl * 1000);
          newUl = Math.round(ul * 1000);
        } else {
          newDl = Math.round((dl / 1000) * 100) / 100;
          newUl = Math.round((ul / 1000) * 100) / 100;
        }
        setSettings(prev => ({
          ...prev,
          speedLimitUnit: newUnit,
          downloadSpeedLimit: String(newDl),
          uploadSpeedLimit: String(newUl),
        }));
        return;
      }
    }
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  // Toggle a value in an array setting
  const toggleArraySetting = (key: 'preferredCodecs' | 'preferredResolutions' | 'preferredMovieGroups', value: string) => {
    setSettings(prev => {
      const currentArray = prev[key] || [];
      const newArray = currentArray.includes(value)
        ? currentArray.filter(v => v !== value)
        : [...currentArray, value];
      // Ensure at least one value is selected
      if (newArray.length === 0) return prev;
      return { ...prev, [key]: newArray };
    });
  };

  // Add a custom value to an array setting
  const addCustomValue = (key: 'preferredCodecs' | 'preferredResolutions' | 'preferredMovieGroups', value: string) => {
    const trimmedValue = value.trim().toLowerCase();
    if (!trimmedValue) return;
    
    setSettings(prev => {
      const currentArray = prev[key] || [];
      // Don't add if already exists (case-insensitive check)
      if (currentArray.some(v => v.toLowerCase() === trimmedValue)) return prev;
      return { ...prev, [key]: [...currentArray, trimmedValue] };
    });
  };

  // Remove a value from an array setting
  const removeFromArray = (key: 'preferredCodecs' | 'preferredResolutions' | 'preferredMovieGroups', value: string) => {
    setSettings(prev => {
      const currentArray = prev[key] || [];
      const newArray = currentArray.filter(v => v !== value);
      // Ensure at least one value is selected
      if (newArray.length === 0) return prev;
      return { ...prev, [key]: newArray };
    });
  };

  // Handle adding custom resolution
  const handleAddResolution = () => {
    addCustomValue('preferredResolutions', customResolution);
    setCustomResolution('');
  };

  // Handle adding custom codec
  const handleAddCodec = () => {
    addCustomValue('preferredCodecs', customCodec);
    setCustomCodec('');
  };

  // Handle adding custom release group
  const handleAddGroup = () => {
    addCustomValue('preferredMovieGroups', customGroup);
    setCustomGroup('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Settings className="w-8 h-8 text-primary-400" />
          <h1 className="text-3xl font-bold">Settings</h1>
        </div>
        <button
          className="btn-primary flex items-center gap-2"
          onClick={saveSettings}
          disabled={saving}
        >
          {saving ? (
            <div className="animate-spin rounded-full h-5 w-5 border-t-2 border-b-2 border-white"></div>
          ) : (
            <Save className="w-5 h-5" />
          )}
          Save Settings
        </button>
      </div>

      {/* Message banner */}
      {message && (
        <div className={`mb-4 p-4 rounded-lg shadow-lg ${
          message.type === 'success' ? 'bg-green-900/50 text-green-200' : 'bg-red-900/50 text-red-200'
        }`}>
          <div className="flex items-center justify-between">
            <span>{message.text}</span>
            <button onClick={() => setMessage(null)} className="ml-3 hover:opacity-80">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Mobile tabs - horizontal scroll */}
      <div className="md:hidden flex gap-1 overflow-x-auto pb-3 mb-4 scrollbar-hide">
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveSection(id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              activeSection === id
                ? 'bg-primary-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:text-white hover:bg-slate-700'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex gap-6">
        {/* Desktop sidebar */}
        <nav className="hidden md:block w-48 flex-shrink-0">
          <div className="sticky top-4 space-y-1">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveSection(id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  activeSection === id
                    ? 'bg-primary-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
                {id === 'vpn' && vpnStatus && (
                  <span className={`ml-auto w-2 h-2 rounded-full ${
                    vpnStatus.available ? 'bg-green-400' : vpnStatus.configured ? 'bg-yellow-400' : 'bg-red-400'
                  }`} />
                )}
              </button>
            ))}
          </div>
        </nav>

        {/* Content area */}
        <div className="flex-1 min-w-0">

          {/* VPN Settings */}
          {activeSection === 'vpn' && (
          <section className="card">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-xl font-bold">VPN Configuration</h2>
              {vpnStatus && (
              <div className={`flex items-center gap-2 text-sm px-3 py-1 rounded-full ${
                vpnStatus.available 
                  ? 'bg-green-900/50 text-green-300' 
                  : vpnStatus.configured 
                    ? 'bg-yellow-900/50 text-yellow-300'
                    : 'bg-red-900/50 text-red-300'
              }`}>
                {vpnStatus.available ? (
                  <CheckCircle className="w-4 h-4" />
                ) : vpnStatus.configured ? (
                  <AlertCircle className="w-4 h-4" />
                ) : (
                  <XCircle className="w-4 h-4" />
                )}
                <span>
                  {vpnStatus.available 
                    ? 'Connected' 
                    : vpnStatus.configured 
                      ? 'Starting...'
                      : 'Not Configured'}
                </span>
              </div>
              )}
            </div>
            <p className="text-slate-400 mb-4">
              Configure your PIA VPN credentials for secure downloading. After saving your credentials,
              the QBittorrent container needs to be restarted to connect to the VPN.
            </p>
            
            {vpnStatus && vpnStatus.configured && !vpnStatus.available && (
              <div className="bg-yellow-900/30 border border-yellow-700 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-yellow-200 font-medium">QBittorrent Not Available</p>
                    <p className="text-yellow-300/80 text-sm mt-1">
                      VPN credentials are configured but QBittorrent is not responding. 
                      This can happen if the container is still starting or needs to be restarted.
                    </p>
                    <p className="text-yellow-300/80 text-sm mt-2">
                      Run the following command on the host system:
                    </p>
                    <code className="block bg-slate-900 text-slate-300 px-3 py-2 rounded mt-2 text-sm font-mono">
                      docker compose up -d pia-qbittorrent
                    </code>
                  </div>
                </div>
              </div>
            )}
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">VPN Username</label>
                <input
                  type="text"
                  className="input"
                  value={settings.vpnUsername || ''}
                  onChange={(e) => updateSetting('vpnUsername', e.target.value)}
                  placeholder="Enter VPN username"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">VPN Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="input pr-10"
                    value={settings.vpnPassword || ''}
                    onChange={(e) => updateSetting('vpnPassword', e.target.value)}
                    placeholder="Enter VPN password"
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">VPN Region</label>
                <select
                  className="input"
                  value={settings.vpnRegion || ''}
                  onChange={(e) => updateSetting('vpnRegion', e.target.value)}
                  disabled={regionsLoading}
                >
                  {regionsLoading ? (
                    <option value="">Loading regions...</option>
                  ) : (
                    <>
                      <option value="">Select a region...</option>
                      {vpnRegions.map(region => (
                        <option key={region.id} value={region.id}>
                          {region.name} {region.portForward ? '✓' : '(no port forward)'}
                        </option>
                      ))}
                    </>
                  )}
                </select>
                <p className="text-xs text-slate-400 mt-1">
                  ✓ indicates regions that support port forwarding for better speeds
                </p>
              </div>
              
              <div className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                <div>
                  <label className="block text-sm font-medium">Port Forwarding</label>
                  <p className="text-xs text-slate-400 mt-1">
                    Enable VPN port forwarding for better torrent connectivity
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => updateSetting('portForwarding', settings.portForwarding === 'true' ? 'false' : 'true')}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    settings.portForwarding !== 'false' ? 'bg-primary-600' : 'bg-slate-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      settings.portForwarding !== 'false' ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>
              
              <div className="pt-2">
                <button
                  className="btn-secondary flex items-center gap-2"
                  onClick={restartVpn}
                  disabled={restarting || !settings.vpnUsername || !settings.vpnPassword}
                >
                  {restarting ? (
                    <RefreshCw className="w-5 h-5 animate-spin" />
                  ) : (
                    <RefreshCw className="w-5 h-5" />
                  )}
                  Apply VPN Settings
                </button>
                <p className="text-sm text-slate-500 mt-2">
                  Saves credentials and restarts the VPN container to apply changes.
                </p>
              </div>
            </div>
          </section>
          )}

          {/* Bandwidth Settings */}
          {activeSection === 'bandwidth' && (
          <section className="card">
            <h2 className="text-xl font-bold mb-4">Bandwidth Limits</h2>
            <p className="text-slate-400 mb-4">
              Set download and upload speed limits. Use 0 for unlimited.
            </p>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Speed Unit</label>
                <select
                  className="input w-32"
                  value={settings.speedLimitUnit || 'MB'}
                  onChange={(e) => updateSetting('speedLimitUnit', e.target.value)}
                >
                  <option value="KB">KB/s</option>
                  <option value="MB">MB/s</option>
                </select>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Download Limit ({settings.speedLimitUnit || 'MB'}/s)
                  </label>
                  <input
                    type="number"
                    className="input"
                    value={settings.downloadSpeedLimit || '0'}
                    onChange={(e) => updateSetting('downloadSpeedLimit', e.target.value)}
                    min="0"
                    placeholder="0 = Unlimited"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Upload Limit ({settings.speedLimitUnit || 'MB'}/s)
                  </label>
                  <input
                    type="number"
                    className="input"
                    value={settings.uploadSpeedLimit || '0'}
                    onChange={(e) => updateSetting('uploadSpeedLimit', e.target.value)}
                    min="0"
                    placeholder="0 = Unlimited"
                  />
                </div>
              </div>
            </div>
          </section>
          )}

          {/* API Settings */}
          {activeSection === 'api' && (
          <section className="card">
            <h2 className="text-xl font-bold mb-4">API Configuration</h2>
            <p className="text-slate-400 mb-4">
              Configure API keys for external services.
            </p>
            
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium mb-1">OMDB API Key</label>
                <input
                  type="text"
                  className="input"
                  value={settings.omdbApiKey || ''}
                  onChange={(e) => updateSetting('omdbApiKey', e.target.value)}
                  placeholder="Enter OMDB API key"
                />
                <p className="text-sm text-slate-500 mt-1">
                  Get a free API key at <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:underline">omdbapi.com</a>
                </p>
              </div>
            </div>
          </section>
          )}

          {/* AI Recommendations */}
          {activeSection === 'ai' && (
          <section className="card">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="w-6 h-6 text-amber-400" />
              <h2 className="text-xl font-bold">AI Recommendations</h2>
            </div>

            {/* Sub-tabs: Settings vs Dismissed */}
            <div className="flex gap-1 mb-6 border-b border-slate-700">
              <button
                onClick={() => setAiTab('settings')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  aiTab === 'settings'
                    ? 'border-amber-400 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                Configuration
              </button>
              <button
                onClick={() => { setAiTab('dismissed'); loadDismissed(); }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  aiTab === 'dismissed'
                    ? 'border-amber-400 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                Dismissed
                {dismissedKeys.length > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-slate-600 text-slate-300">
                    {dismissedKeys.length}
                  </span>
                )}
              </button>
            </div>

            {aiTab === 'settings' && (
            <>
            <p className="text-slate-400 mb-4">
              Configure OpenRouter to get AI-powered movie and TV show recommendations based on your library.
            </p>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">OpenRouter API Key</label>
                <input
                  type="password"
                  className="input"
                  value={settings.openrouterApiKey || ''}
                  onChange={(e) => updateSetting('openrouterApiKey', e.target.value)}
                  placeholder="sk-or-..."
                />
                <p className="text-sm text-slate-500 mt-1">
                  Get an API key at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary-400 hover:underline">openrouter.ai/keys</a>
                </p>
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">AI Model</label>
                <input
                  type="text"
                  className="input"
                  value={settings.openrouterModel || 'qwen/qwen3-8b'}
                  onChange={(e) => updateSetting('openrouterModel', e.target.value)}
                  placeholder="qwen/qwen3-8b"
                />
                <p className="text-sm text-slate-500 mt-1">
                  Model to use for recommendations. Default: qwen/qwen3-8b. Must support structured output.
                </p>
              </div>

              {settings.openrouterApiKey && (
                <div className="pt-2">
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    onClick={async () => {
                      try {
                        await saveSettings();
                        const result = await api.testOpenRouterConnection();
                        setMessage({
                          type: result.success ? 'success' : 'error',
                          text: result.success
                            ? `OpenRouter connected successfully (model: ${result.model})`
                            : `OpenRouter connection failed: ${result.message}`,
                        });
                      } catch {
                        setMessage({ type: 'error', text: 'Failed to test OpenRouter connection' });
                      }
                    }}
                  >
                    Test Connection
                  </button>
                </div>
              )}
            </div>
            </>
            )}

            {aiTab === 'dismissed' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <p className="text-slate-400 text-sm">
                  Recommendations you&apos;ve dismissed. Restore them to see them again in your suggestions.
                </p>
                {dismissedKeys.length > 0 && (
                  <button
                    onClick={handleRestoreAll}
                    className="text-sm text-primary-400 hover:text-primary-300 whitespace-nowrap ml-4"
                  >
                    Restore All
                  </button>
                )}
              </div>
              {dismissedLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-amber-400"></div>
                </div>
              ) : dismissedKeys.length === 0 ? (
                <p className="text-slate-500 text-sm py-4 text-center">No dismissed recommendations</p>
              ) : (
                <div className="space-y-2">
                  {dismissedKeys.map(key => (
                    <div key={key} className="flex items-center justify-between p-3 bg-slate-700/30 rounded-lg">
                      <span className="text-slate-200">{key.replace(/-(\d+)$/, ' ($1)')}</span>
                      <button
                        onClick={() => handleRestore(key)}
                        className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            )}
          </section>
          )}

          {/* Torrent Search Preferences */}
          {activeSection === 'torrent' && (
          <section className="card">
            <div className="flex items-center gap-3 mb-4">
              <Film className="w-6 h-6 text-primary-400" />
              <h2 className="text-xl font-bold">Torrent Search Preferences</h2>
            </div>
            <p className="text-slate-400 mb-4">
              Configure your preferred quality settings. Torrents matching these preferences will be scored higher during auto-download.
              Click suggestions to add them, or type your own custom values.
            </p>
            
            <div className="space-y-6">
              {/* Preferred Resolutions */}
              <div>
                <label className="block text-sm font-medium mb-2">Preferred Resolutions</label>
                
                <div className="flex flex-wrap gap-2 mb-3">
                  {(settings.preferredResolutions || []).map(res => (
                    <span
                      key={res}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white"
                    >
                      {res}
                      <button
                        type="button"
                        onClick={() => removeFromArray('preferredResolutions', res)}
                        className="hover:bg-primary-700 rounded-full p-0.5 transition-colors"
                        title="Remove"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
                
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    className="input flex-1"
                    value={customResolution}
                    onChange={(e) => setCustomResolution(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddResolution())}
                    placeholder="Add custom resolution (e.g., 576p, 8K)"
                  />
                  <button
                    type="button"
                    onClick={handleAddResolution}
                    disabled={!customResolution.trim()}
                    className="btn-secondary flex items-center gap-1 px-3"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  <span className="text-xs text-slate-500 self-center">Suggestions:</span>
                  {SUGGESTED_RESOLUTIONS.filter(res => !settings.preferredResolutions?.includes(res)).map(res => (
                    <button
                      key={res}
                      type="button"
                      onClick={() => toggleArraySetting('preferredResolutions', res)}
                      className="px-2 py-1 rounded text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                    >
                      + {res}
                    </button>
                  ))}
                </div>
                <p className="text-sm text-slate-500 mt-2">
                  720p is a good balance of quality and file size. Add multiple resolutions to find more results.
                </p>
              </div>
              
              {/* Preferred Codecs */}
              <div>
                <label className="block text-sm font-medium mb-2">Preferred Video Codecs</label>
                
                <div className="flex flex-wrap gap-2 mb-3">
                  {(settings.preferredCodecs || []).map(codec => (
                    <span
                      key={codec}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white"
                    >
                      {codec}
                      <button
                        type="button"
                        onClick={() => removeFromArray('preferredCodecs', codec)}
                        className="hover:bg-primary-700 rounded-full p-0.5 transition-colors"
                        title="Remove"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
                
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    className="input flex-1"
                    value={customCodec}
                    onChange={(e) => setCustomCodec(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddCodec())}
                    placeholder="Add custom codec (e.g., H264, ProRes)"
                  />
                  <button
                    type="button"
                    onClick={handleAddCodec}
                    disabled={!customCodec.trim()}
                    className="btn-secondary flex items-center gap-1 px-3"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  <span className="text-xs text-slate-500 self-center">Suggestions:</span>
                  {SUGGESTED_CODECS.filter(codec => !settings.preferredCodecs?.includes(codec)).map(codec => (
                    <button
                      key={codec}
                      type="button"
                      onClick={() => toggleArraySetting('preferredCodecs', codec)}
                      className="px-2 py-1 rounded text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                    >
                      + {codec}
                    </button>
                  ))}
                </div>
                <p className="text-sm text-slate-500 mt-2">
                  x264 is most compatible. x265/HEVC offers smaller files with similar quality.
                </p>
              </div>
              
              {/* Preferred Release Groups */}
              <div>
                <label className="block text-sm font-medium mb-2">Preferred Release Groups</label>
                
                <div className="flex flex-wrap gap-2 mb-3">
                  {(settings.preferredMovieGroups || []).map(group => (
                    <span
                      key={group}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary-600 text-white"
                    >
                      {group.toUpperCase()}
                      <button
                        type="button"
                        onClick={() => removeFromArray('preferredMovieGroups', group)}
                        className="hover:bg-primary-700 rounded-full p-0.5 transition-colors"
                        title="Remove"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
                
                <div className="flex gap-2 mb-3">
                  <input
                    type="text"
                    className="input flex-1"
                    value={customGroup}
                    onChange={(e) => setCustomGroup(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddGroup())}
                    placeholder="Add custom release group (e.g., NTb, FGT, FLUX)"
                  />
                  <button
                    type="button"
                    onClick={handleAddGroup}
                    disabled={!customGroup.trim()}
                    className="btn-secondary flex items-center gap-1 px-3"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
                
                <div className="flex flex-wrap gap-2">
                  <span className="text-xs text-slate-500 self-center">Suggestions:</span>
                  {SUGGESTED_GROUPS.filter(group => !settings.preferredMovieGroups?.includes(group)).map(group => (
                    <button
                      key={group}
                      type="button"
                      onClick={() => toggleArraySetting('preferredMovieGroups', group)}
                      className="px-2 py-1 rounded text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
                    >
                      + {group.toUpperCase()}
                    </button>
                  ))}
                </div>
                <p className="text-sm text-slate-500 mt-2">
                  YIFY/YTS releases are known for small file sizes. RARBG and SPARKS are known for quality.
                  Add any release group name to prioritize it.
                </p>
              </div>
            </div>
          </section>
          )}

          {/* Storage Devices */}
          {activeSection === 'storage' && (
          <section className="card">
            <div className="flex items-center gap-3 mb-4">
              <HardDrive className="w-6 h-6 text-primary-400" />
              <h2 className="text-xl font-bold">Storage Devices</h2>
            </div>
            <p className="text-slate-400 mb-4">
              Storage devices used for media files. External disks can be added using the host setup script at <code className="bg-slate-900 px-1 rounded">/qar/disks</code>.
            </p>
            
            {disks.length === 0 ? (
              <div className="text-center py-8 text-slate-400">
                <HardDrive className="w-12 h-12 mx-auto mb-2 opacity-50" />
                <p>No storage devices configured</p>
              </div>
            ) : (
              <div className="space-y-4">
                {disks.map(disk => (
                  <div key={disk.name} className="bg-slate-700/50 rounded-lg p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <HardDrive className="w-6 h-6 text-primary-400" />
                      <div>
                        <h3 className="font-medium">Disk {disk.name.toUpperCase()}</h3>
                        <p className="text-xs text-slate-400">{disk.path}</p>
                      </div>
                    </div>

                    <div className="relative h-3 bg-slate-600 rounded-full overflow-hidden mb-2">
                      <div
                        className={`absolute inset-y-0 left-0 rounded-full transition-all ${getUsageColor(disk.usedPercent)}`}
                        style={{ width: `${disk.usedPercent}%` }}
                      />
                    </div>

                    <div className="flex justify-between text-sm">
                      <span className="text-slate-400">
                        {formatBytes(disk.usedBytes)} used
                      </span>
                      <span className="text-slate-400">
                        {formatBytes(disk.freeBytes)} free
                      </span>
                    </div>
                    <div className="text-right text-sm font-medium mt-1">
                      {disk.usedPercent.toFixed(1)}% of {formatBytes(disk.totalBytes)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          )}

        </div>
      </div>
    </div>
  );
}
