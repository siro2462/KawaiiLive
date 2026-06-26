/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Database,
  Menu,
  Radio,
  Tv,
  X,
} from 'lucide-react';
import { ConsoleLog, DatabaseTable, LiveStream, SpeechLine } from './types';
import * as api from './api';
import OnAirView from './components/OnAirView';
import DataStudioView from './components/DataStudioView';

type TabId = 'onair' | 'data';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('onair');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [lives, setLives] = useState<LiveStream[]>([]);
  const [selectedLiveId, setSelectedLiveId] = useState<string>('');
  const [speechLines, setSpeechLines] = useState<SpeechLine[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const [sqliteTables, setSqliteTables] = useState<DatabaseTable[]>([]);
  const [serverStatus, setServerStatus] = useState<any>(null);
  const [headerMessage, setHeaderMessage] = useState('');
  const seenRemoteLogIds = useRef<Set<string>>(new Set());
  const previousSynthesizing = useRef(false);

  const currentLive = useMemo(
    () => lives.find((lv) => lv.id === selectedLiveId) || lives[0] || null,
    [lives, selectedLiveId],
  );

  const addConsoleLog = useCallback((level: ConsoleLog['level'], message: string) => {
    const timestamp = new Date().toTimeString().split(' ')[0];
    setConsoleLogs((prev) => [
      ...prev.slice(-250),
      {
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp,
        level,
        message,
      },
    ]);
  }, []);

  const loadSpeechLines = useCallback(
    async (liveId: string) => {
      if (!liveId) {
        setSpeechLines([]);
        return;
      }
      try {
        const rows = await api.fetchSpeechLines(Number(liveId));
        setSpeechLines(rows);
        addConsoleLog('info', `Loaded ${rows.length} speech lines for live ${liveId}.`);
      } catch (error: any) {
        setSpeechLines([]);
        addConsoleLog('error', `Failed to load speech lines: ${error.message}`);
      }
    },
    [addConsoleLog],
  );

  const loadLives = useCallback(async () => {
    const fetched = await api.fetchLives();
    setLives(fetched);
    setSelectedLiveId((prev) => {
      if (prev && fetched.some((live) => live.id === prev)) return prev;
      return fetched[0]?.id || '';
    });
    return fetched;
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadLives()
      .then((fetched) => {
        if (cancelled) return;
        addConsoleLog('success', `Connected to dashboard DB. Loaded ${fetched.length} lives.`);
        const firstId = fetched[0]?.id;
        if (firstId) void loadSpeechLines(firstId);
      })
      .catch((error: any) => {
        if (!cancelled) addConsoleLog('error', `Failed to load lives: ${error.message}`);
      });

    api.fetchSqliteTables()
      .then((tables) => {
        if (!cancelled) setSqliteTables(tables);
      })
      .catch((error: any) => {
        if (!cancelled) addConsoleLog('error', `Failed to load SQLite tables: ${error.message}`);
      });

    return () => {
      cancelled = true;
    };
  }, [addConsoleLog, loadLives, loadSpeechLines]);

  useEffect(() => {
    const poll = () => api.fetchStatus().then((status) => {
      const wasSynthesizing = previousSynthesizing.current;
      const isSynthesizing = !!status.radio?.script?.synthesizing;
      previousSynthesizing.current = isSynthesizing;
      setServerStatus(status);
      ingestRemoteLogs(status, seenRemoteLogIds.current, addConsoleLog);
      if (wasSynthesizing && !isSynthesizing) {
        void loadLives();
        if (selectedLiveId) void loadSpeechLines(selectedLiveId);
        addConsoleLog('success', 'TTS synthesis finished. Refreshed live audio status.');
      }
    }).catch(() => {});
    poll();
    const id = window.setInterval(poll, 2000);
    return () => window.clearInterval(id);
  }, [addConsoleLog, loadLives, loadSpeechLines, selectedLiveId]);

  useEffect(() => {
    if (selectedLiveId) void loadSpeechLines(selectedLiveId);
  }, [selectedLiveId, loadSpeechLines]);

  const handleDeleteLives = (ids: string[]) => {
    api.deleteLives(ids.map(Number))
      .then(() => {
        setLives((prev) => prev.filter((lv) => !ids.includes(lv.id)));
        if (ids.includes(selectedLiveId)) {
          setSelectedLiveId('');
          setSpeechLines([]);
        }
        addConsoleLog('success', `Deleted live records: ${ids.join(', ')}.`);
      })
      .catch((error: any) => addConsoleLog('error', `Delete failed: ${error.message}`));
  };

  const handleSelectLive = (id: string) => {
    setSelectedLiveId(id);
  };

  const handleToggleSpeechLineSpoken = (lineId: string) => {
    setSpeechLines((prev) =>
      prev.map((line) => (line.id === lineId ? { ...line, isSpoken: true } : line)),
    );
  };

  const handleStartRadio = async () => {
    const liveId = Number(currentLive?.id || selectedLiveId || 0);
    if (!liveId) {
      const error = new Error('No live is selected.');
      addConsoleLog('warn', error.message);
      throw error;
    }
    addConsoleLog('info', `Starting radio playback for live #${liveId}...`);
    const result = await api.startRadio('chatter', liveId);
    if (result?.radio?.state !== 'running') {
      throw new Error(result?.radio?.error || `Radio did not start. state=${result?.radio?.state || 'unknown'}`);
    }
    addConsoleLog('success', `Radio playback started for live #${liveId}.`);
  };

  const handleStopRadio = async () => {
    addConsoleLog('warn', 'Requesting radio stop...');
    await api.stopRadio();
  };

  const handleGenerateScript = async (minutes: number, count: number = 1) => {
    const batchLabel = count > 1 ? ` x ${count}` : '';
    addConsoleLog('info', `Starting script generation (${minutes} min${batchLabel}).`);
    try {
      const result = await api.prepareScript(minutes, count);
      addConsoleLog('success', result.message || 'Script generation started.');
      if (count === 1) {
        const fetched = await loadLives();
        const nextId = fetched[0]?.id;
        if (nextId) setSelectedLiveId(nextId);
      }
    } catch (error: any) {
      addConsoleLog('error', `Script generation failed: ${error.message}`);
      throw error;
    }
  };

  const handleGenerateTts = async () => {
    if (!selectedLiveId) {
      const error = new Error('No live is selected.');
      addConsoleLog('warn', error.message);
      throw error;
    }
    addConsoleLog('info', `Starting TTS synthesis for live ${selectedLiveId}.`);
    try {
      await api.synthesizeTts(Number(selectedLiveId));
      addConsoleLog('success', 'TTS synthesis started in the background.');
      window.setTimeout(() => {
        void loadLives();
        void loadSpeechLines(selectedLiveId);
      }, 2500);
    } catch (error: any) {
      addConsoleLog('error', `TTS failed: ${error.message}`);
      throw error;
    }
  };

  const handleRestartServer = async () => {
    setHeaderMessage('Restart request sending...');
    addConsoleLog('warn', 'Requesting server restart.');
    try {
      await api.restartServer();
      setHeaderMessage('Restart request accepted. Refresh after a few seconds.');
      addConsoleLog('success', 'Restart request accepted. Reopen or refresh after a few seconds.');
    } catch (error: any) {
      setHeaderMessage(`Restart failed: ${error.message}`);
      addConsoleLog('error', `Restart request failed: ${error.message}`);
    }
  };

  const handleStopServer = async () => {
    setHeaderMessage('Stop request sending...');
    addConsoleLog('error', 'Requesting server stop.');
    try {
      await api.stopServer();
      setHeaderMessage('Stop request accepted. Server is shutting down.');
      addConsoleLog('success', 'Stop request accepted. The control server will shut down.');
    } catch (error: any) {
      setHeaderMessage(`Stop failed: ${error.message}`);
      addConsoleLog('error', `Stop request failed: ${error.message}`);
    }
  };

  const ollamaReady = serverStatus?.ollama === true;
  const broadcastState = serverStatus?.broadcast?.state || 'idle';
  const obsConnected = serverStatus?.obs?.connected === true;
  const dbConnected = lives.length > 0;
  const serverReady = serverStatus !== null;

  const navItems = [
    {
      id: 'onair' as const,
      label: 'On Air',
      subtitle: 'Broadcast Console',
      icon: Tv,
    },
    {
      id: 'data' as const,
      label: 'Data Studio',
      subtitle: 'SQLite / Vector DB',
      icon: Database,
    },
  ];

  return (
    <div className="h-screen w-screen bg-slate-50 text-slate-800 font-sans selection:bg-indigo-150 selection:text-indigo-900 flex flex-col overflow-hidden animate-fade-in">
      <header className="bg-slate-900 text-white flex items-center justify-between px-4 md:px-6 h-14 border-b border-slate-800 w-full shrink-0 z-50 shadow-md">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            className="md:hidden p-1.5 text-slate-300 hover:text-white cursor-pointer hover:bg-slate-800 transition"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <Radio className="w-5 h-5 text-indigo-400 animate-pulse" />
          <div className="hidden sm:flex flex-col leading-tight">
            <span className="text-xs font-black tracking-widest uppercase">KawaiiLive</span>
            <span className="text-[10px] text-slate-400 font-mono">Dashboard DB mode</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleStopServer}
            className="hidden sm:flex text-[10px] items-center gap-1.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 px-2.5 py-1.5 font-bold transition cursor-pointer font-mono"
            title="Stop server"
          >
            <X className="w-3.5 h-3.5" />
            <span>FORCE STOP</span>
          </button>
          <button
            onClick={handleRestartServer}
            className="hidden sm:flex text-[10px] items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2.5 py-1.5 font-bold transition cursor-pointer font-mono"
            title="Restart server"
          >
            <Activity className="w-3.5 h-3.5" />
            <span>RESTART</span>
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="absolute top-14 left-0 right-0 bg-slate-950 p-4 flex flex-col gap-1.5 z-50 border-b border-slate-800 animate-fade-in font-sans rounded-none md:hidden shadow-2xl">
            {navItems.map((item) => {
              const IconComp = item.icon;
              const isSelected = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                    addConsoleLog('info', `Opened ${item.label}.`);
                  }}
                  className={`p-2.5 rounded-none font-bold flex items-center justify-between text-xs cursor-pointer transition ${
                    isSelected ? 'bg-slate-800 text-white border border-slate-700' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <IconComp className={`w-4 h-4 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`} />
                    <span>{item.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {headerMessage && (
        <div className="border-b border-slate-200 bg-amber-50 px-4 py-2 text-[11px] font-bold text-amber-800">
          {headerMessage}
        </div>
      )}

      <div className="flex-1 flex flex-row overflow-hidden w-full min-h-0">
        <aside className={`hidden md:flex shrink-0 bg-slate-900 text-slate-100 flex-col justify-between transition-all duration-300 border-r border-slate-800 rounded-none h-full ${sidebarOpen ? 'w-64 p-5' : 'w-16 p-3'}`}>
          <div className="space-y-6">
            <div className="flex items-center justify-end">
              <button
                onClick={() => setSidebarOpen((prev) => !prev)}
                className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded-none cursor-pointer shrink-0"
                title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
              >
                {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>

            <nav className="space-y-2 select-none font-sans">
              {navItems.map((item) => {
                const IconComp = item.icon;
                const isSelected = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setActiveTab(item.id);
                      addConsoleLog('info', `Opened ${item.label}.`);
                    }}
                    className={`w-full text-left rounded-none transition flex flex-col cursor-pointer ${
                      sidebarOpen ? 'px-3.5 py-3 gap-0.5' : 'p-2.5 items-center justify-center'
                    } ${
                      isSelected
                        ? 'bg-slate-800 text-white border border-slate-700 shadow-sm'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-white'
                    }`}
                    title={!sidebarOpen ? item.label : undefined}
                  >
                    <div className={`flex items-center font-extrabold text-xs font-sans ${sidebarOpen ? 'gap-2.5' : 'justify-center'}`}>
                      <IconComp className={`w-4 h-4 shrink-0 ${isSelected ? 'text-indigo-400' : 'text-slate-500'}`} />
                      {sidebarOpen && <span>{item.label}</span>}
                    </div>
                    {sidebarOpen && (
                      <span className="text-[9px] text-slate-500 font-bold pl-6 leading-relaxed flex-shrink-0">
                        {item.subtitle}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex flex-col gap-2 pt-3 px-2 shrink-0 select-none pb-4">
            {[
              ['Broadcast', broadcastState, broadcastState === 'live'],
              ['OBS', obsConnected ? 'connected' : 'disconnected', obsConnected],
              ['Ollama', ollamaReady ? 'ready' : 'offline', ollamaReady],
              ['Database', dbConnected ? 'connected' : 'no data', dbConnected],
            ].map(([label, value, ok]) => (
              <div key={label as string} className={`flex items-center gap-2 text-[10px] text-slate-400 font-mono select-none ${sidebarOpen ? 'w-full' : 'justify-center'}`}>
                <span className={`w-1.5 h-1.5 rounded-none shrink-0 ${ok ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`} />
                {sidebarOpen && <span className="truncate">{label}: {value as string}</span>}
              </div>
            ))}
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0 max-w-full h-full overflow-hidden">
          <main className="flex-1 overflow-y-auto px-4 md:px-8 py-6 max-w-7xl mx-auto w-full">
            {activeTab === 'onair' && (
              <div className="animate-fade-in">
                <OnAirView
                  lives={lives}
                  currentLive={currentLive}
                  onSelectLive={handleSelectLive}
                  speechLines={speechLines}
                  onToggleSpeechLineSpoken={handleToggleSpeechLineSpoken}
                  consoleLogs={consoleLogs}
                  onClearLogs={() => setConsoleLogs([])}
                  onAddConsoleLog={addConsoleLog}
                  radioStatus={serverStatus?.radio}
                  onStartRadio={handleStartRadio}
                  onStopRadio={handleStopRadio}
                  serverReady={serverReady}
                />
              </div>
            )}

            {activeTab === 'data' && (
              <div className="animate-fade-in">
                <DataStudioView
                  lives={lives}
                  onDeleteLives={handleDeleteLives}
                  speechLines={speechLines}
                  sqliteTables={sqliteTables}
                  onAddConsoleLog={addConsoleLog}
                  consoleLogs={consoleLogs}
                  onClearLogs={() => setConsoleLogs([])}
                  scriptStatus={serverStatus?.radio?.script || null}
                  onGenerateScript={handleGenerateScript}
                  onGenerateTts={handleGenerateTts}
                  serverReady={serverReady}
                />
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function ingestRemoteLogs(
  status: any,
  seen: Set<string>,
  addConsoleLog: (level: ConsoleLog['level'], message: string) => void,
) {
  const scriptLogs = Array.isArray(status?.scriptLlmLog) ? status.scriptLlmLog : [];
  for (const entry of scriptLogs) {
    const id = `script:${entry.id || entry.at || ''}:${entry.type || ''}:${entry.memoryId || ''}:${entry.totalLines || ''}`;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    addConsoleLog(scriptLogLevel(entry), formatScriptLog(entry));
  }

  const chatLogs = Array.isArray(status?.chatLog) ? status.chatLog : [];
  for (const entry of chatLogs) {
    const id = `chat:${entry.id || entry.at || ''}`;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const author = entry.author || entry.source || 'viewer';
    const text = entry.text || entry.message || '';
    if (text) addConsoleLog('info', `[CHAT] ${author}: ${text}`);
  }

  if (seen.size > 1000) {
    const latest = Array.from(seen).slice(-500);
    seen.clear();
    latest.forEach((id) => seen.add(id));
  }
}

function scriptLogLevel(entry: any): ConsoleLog['level'] {
  const type = String(entry?.type || '').toLowerCase();
  if (type.includes('warn') || type.includes('fallback')) return 'warn';
  if (type.includes('error') || type.includes('fail')) return 'error';
  if (type === 'done') return 'success';
  return 'info';
}

function formatScriptLog(entry: any) {
  const type = String(entry?.type || 'script').toUpperCase();
  if (entry?.error) return `[SCRIPT:${type}] ${entry.error}`;
  if (entry?.message) return `[SCRIPT:${type}] ${entry.message}`;
  if (entry?.plan_note) return `[SCRIPT:${type}] ${entry.plan_note}`;
  if (entry?.blocks) return `[SCRIPT:${type}] planned ${entry.blocks.length} blocks`;
  if (entry?.memoryId) {
    const parts = [`memory #${entry.memoryId}`];
    if (entry.prompt_type) parts.push(entry.prompt_type);
    if (entry.blockChars || entry.chars) parts.push(`${entry.blockChars || entry.chars} chars`);
    if (entry.accepted !== undefined) parts.push(`${entry.accepted} accepted`);
    return `[SCRIPT:${type}] ${parts.join(' / ')}`;
  }
  if (entry?.totalLines !== undefined) return `[SCRIPT:${type}] total ${entry.totalLines} lines`;
  return `[SCRIPT:${type}] ${JSON.stringify(entry).slice(0, 180)}`;
}
