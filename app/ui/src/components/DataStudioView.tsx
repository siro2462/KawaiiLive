/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clipboard,
  DatabaseZap,
  Download,
  Layers,
  Play,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  Tv,
  Volume2,
  X,
} from 'lucide-react';
import { ConsoleLog, DatabaseTable, LiveStream, SpeechLine, VectorItem } from '../types';
import * as api from '../api';

interface DataStudioViewProps {
  lives: LiveStream[];
  onDeleteLives: (ids: string[]) => void;
  speechLines: SpeechLine[];
  sqliteTables: DatabaseTable[];
  onAddConsoleLog: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void;
  consoleLogs: ConsoleLog[];
  onClearLogs: () => void;
  scriptStatus?: {
    preparing?: boolean;
    synthesizing?: boolean;
    progress?: number;
    label?: string;
  } | null;
  onGenerateScript?: (durationMinutes: number, count?: number) => void | Promise<void>;
  onGenerateTts?: (liveIds: string[]) => void | Promise<void>;
  serverReady: boolean;
}

type TabName = 'live' | 'memory' | 'vector';

export default function DataStudioView({
  lives,
  onDeleteLives,
  speechLines,
  sqliteTables,
  onAddConsoleLog,
  consoleLogs,
  onClearLogs,
  scriptStatus,
  onGenerateScript,
  onGenerateTts,
  serverReady,
}: DataStudioViewProps) {
  const [selectedTab, setSelectedTab] = useState<TabName>('live');
  const [scriptDuration, setScriptDuration] = useState(15);
  const [scriptBatchCount, setScriptBatchCount] = useState(1);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [expandedLives, setExpandedLives] = useState<Record<string, boolean>>({});
  const [liveSpeechLines, setLiveSpeechLines] = useState<Record<string, SpeechLine[]>>({});
  const [checkedLives, setCheckedLives] = useState<string[]>([]);
  const [vectors, setVectors] = useState<VectorItem[]>([]);
  const [expandedVectorNodes, setExpandedVectorNodes] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<'script' | 'tts' | null>(null);
  const [actionTone, setActionTone] = useState<'idle' | 'script' | 'tts' | 'success' | 'error'>('idle');
  const [actionMessage, setActionMessage] = useState('');
  const [playingAudioLineId, setPlayingAudioLineId] = useState<string>('');

  useEffect(() => {
    api.fetchAllVectors().then(setVectors).catch((error) => {
      onAddConsoleLog('error', `Vector DB load failed: ${error.message}`);
    });
  }, [onAddConsoleLog]);

  useEffect(() => {
    if (speechLines.length && lives[0]?.id && !liveSpeechLines[lives[0].id]) {
      setLiveSpeechLines((prev) => ({ ...prev, [lives[0].id]: speechLines }));
    }
  }, [speechLines, lives, liveSpeechLines]);

  const memoryRows = useMemo(() => {
    const table = sqliteTables.find(t => t.name === 'memory' || t.name === 'memories');
    return table?.rows || [];
  }, [sqliteTables]);

  const vectorTree = useMemo(() => {
    const flows = vectors.filter(v => v.type === 'flow');
    const topics = vectors.filter(v => v.type === 'topic');
    const styles = vectors.filter(v => v.type === 'style');
    return flows.map(flow => ({
      flow,
      topics: topics
        .filter(topic => topic.flowId === flow.id)
        .map(topic => ({
          topic,
          styles: styles.filter(style => style.topicId === topic.id),
        })),
    }));
  }, [vectors]);

  const toggleLive = (liveId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const nextExpanded = !expandedLives[liveId];
    setExpandedLives(prev => ({ ...prev, [liveId]: nextExpanded }));
    if (nextExpanded && !liveSpeechLines[liveId]) {
      api.fetchSpeechLines(Number(liveId))
        .then(lines => setLiveSpeechLines(prev => ({ ...prev, [liveId]: lines })))
        .catch(error => onAddConsoleLog('error', `Speech lines load failed: ${error.message}`));
    }
  };

  const toggleLiveCheckbox = (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    setCheckedLives(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const deleteCheckedLives = () => {
    if (!checkedLives.length) return;
    onDeleteLives(checkedLives);
    setCheckedLives([]);
  };

  const downloadLiveCsv = async (live: LiveStream, event: React.MouseEvent) => {
    event.stopPropagation();
    setActionMessage(`Downloading CSV for live #${live.id}...`);
    try {
      await api.downloadLiveCsv(Number(live.id));
      onAddConsoleLog('success', `Downloaded CSV for live #${live.id}.`);
      setActionMessage(`Downloaded CSV for live #${live.id}.`);
      setActionTone('success');
    } catch (error: any) {
      onAddConsoleLog('error', `CSV download failed for live #${live.id}: ${error.message}`);
      setActionMessage(`CSV download failed: ${error.message}`);
      setActionTone('error');
    }
  };

  const downloadCheckedCsv = async () => {
    if (!checkedLives.length) {
      setActionMessage('CSV download requires selected lives.');
      setActionTone('error');
      return;
    }
    setActionMessage(`Downloading ${checkedLives.length} CSV file(s)...`);
    try {
      for (const id of checkedLives) {
        await api.downloadLiveCsv(Number(id));
      }
      onAddConsoleLog('success', `Downloaded CSV for live records: ${checkedLives.join(', ')}.`);
      setActionMessage(`Downloaded ${checkedLives.length} CSV file(s).`);
      setActionTone('success');
    } catch (error: any) {
      onAddConsoleLog('error', `CSV download failed: ${error.message}`);
      setActionMessage(`CSV download failed: ${error.message}`);
      setActionTone('error');
    }
  };

  const runWithBusy = async (type: 'script' | 'tts', callback?: () => void | Promise<void>) => {
    if (!callback || busy || remoteBusy) {
      if (!callback) {
        setActionMessage(`${type.toUpperCase()} action is not connected.`);
        setActionTone('error');
      }
      return;
    }
    setBusy(type);
    setActionTone(type);
    setActionMessage(type === 'script' ? 'Script generation request sent...' : 'TTS request sent...');
    try {
      await callback();
      setActionMessage(type === 'script' ? 'Script generation finished.' : 'TTS synthesis started.');
      setActionTone(type === 'script' ? 'success' : 'tts');
    } catch (error: any) {
      setActionMessage(`${type.toUpperCase()} failed: ${error.message}`);
      setActionTone('error');
    } finally {
      setBusy(null);
    }
  };

  const toggleVectorNode = (id: string) => {
    setExpandedVectorNodes(prev => ({ ...prev, [id]: prev[id] === false }));
  };

  const playSpeechLineAudio = async (line: SpeechLine) => {
    const urls = line.audioUrls?.length ? line.audioUrls : line.audioUrl ? [line.audioUrl] : [];
    if (!urls.length) {
      onAddConsoleLog('warn', `No audio URL for line #${line.lineNo}.`);
      return;
    }
    setPlayingAudioLineId(line.id);
    try {
      for (const url of urls) {
        await playAudioUrl(url);
      }
      onAddConsoleLog('info', `Playing audio for line #${line.lineNo}.`);
    } catch (error: any) {
      onAddConsoleLog('error', `Audio playback failed for line #${line.lineNo}: ${error.message}`);
    } finally {
      setPlayingAudioLineId(current => current === line.id ? '' : current);
    }
  };

  const playAudioUrl = (url: string) => new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    audio.addEventListener('ended', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('HTMLAudioElement error')), { once: true });
    audio.play().catch(reject);
  });

  const copySpeechLineCsv = async (line: SpeechLine, live: LiveStream) => {
    const csv = toCsv([
      ['live_id', 'live_title', 'line_no', 'memory_id', 'keyword', 'text', 'audio_url'],
      [live.id, live.title, line.lineNo, line.memoryId, line.topic, line.text, line.audioUrl || ''],
    ]);
    try {
      await copyText(csv);
      onAddConsoleLog('success', `Copied speech line #${line.lineNo} as CSV.`);
      setActionMessage(`Copied line #${line.lineNo} as CSV.`);
      setActionTone('success');
    } catch (error: any) {
      onAddConsoleLog('error', `CSV copy failed for line #${line.lineNo}: ${error.message}`);
      setActionMessage(`CSV copy failed: ${error.message}`);
      setActionTone('error');
    }
  };

  const remoteBusy = !!(scriptStatus?.preparing || scriptStatus?.synthesizing);
  const effectiveBusy = scriptStatus?.preparing ? 'script' : scriptStatus?.synthesizing ? 'tts' : busy;
  const rawProgress = typeof scriptStatus?.progress === 'number'
    ? scriptStatus.progress
    : effectiveBusy
      ? 8
      : actionTone === 'success'
        ? 100
        : actionTone === 'error'
          ? 100
          : 0;
  const statusProgress = Math.max(0, Math.min(100, rawProgress));
  const statusLabel = scriptStatus?.label || actionMessage || 'Idle';
  const statusBarClass = effectiveBusy === 'script'
    ? 'bg-indigo-500 shadow-[0_0_18px_rgba(99,102,241,0.55)]'
    : effectiveBusy === 'tts'
      ? 'bg-emerald-500 shadow-[0_0_18px_rgba(16,185,129,0.55)]'
      : actionTone === 'error'
        ? 'bg-rose-500'
        : actionTone === 'success'
          ? 'bg-sky-400'
          : 'bg-slate-200';

  return (
    <div className="space-y-5" id="data-studio-unified-suite">
      <div className="flex flex-col gap-4 pb-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-6">
          <TabButton
            active={selectedTab === 'live'}
            icon={<Tv className="h-3.5 w-3.5" />}
            label={`Live (${lives.length})`}
            onClick={() => setSelectedTab('live')}
          />
          <TabButton
            active={selectedTab === 'memory'}
            icon={<Brain className="h-3.5 w-3.5" />}
            label={`Memory (${memoryRows.length})`}
            onClick={() => setSelectedTab('memory')}
          />
          <TabButton
            active={selectedTab === 'vector'}
            icon={<Layers className="h-3.5 w-3.5" />}
            label={`Vector (${vectors.length})`}
            onClick={() => setSelectedTab('vector')}
          />
        </div>

        {selectedTab === 'live' && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center border border-slate-200 bg-white">
              <span className="flex items-center gap-1 px-2 text-[10px] font-black uppercase text-slate-500">
                <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
                Script
              </span>
              {[15, 30, 60].map(mins => (
                <button
                  key={mins}
                  onClick={() => setScriptDuration(mins)}
                  className={`px-2 py-1 text-[11px] font-bold ${scriptDuration === mins ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
                >
                  {mins}m
                </button>
              ))}
              <select
                value={scriptBatchCount}
                onChange={(event) => setScriptBatchCount(Number(event.target.value))}
                disabled={busy !== null || remoteBusy || !serverReady}
                className="border-l border-slate-200 bg-white px-1.5 py-1 text-[11px] font-bold text-slate-600 outline-none disabled:opacity-50"
                title="Generate count"
              >
                {[1, 2, 3, 5, 10].map(count => (
                  <option key={count} value={count}>{count}x</option>
                ))}
              </select>
              <button
                onClick={() => void runWithBusy('script', () => onGenerateScript?.(scriptDuration, scriptBatchCount))}
                disabled={busy !== null || remoteBusy || !serverReady}
                className="flex items-center gap-1 border-l border-indigo-700 bg-indigo-600 px-3 py-1 text-[11px] font-bold text-white disabled:opacity-50"
              >
                <DatabaseZap className="h-3 w-3" />
                {serverReady ? 'Generate' : 'Wait...'}
              </button>
            </div>

            <button
              onClick={() => void runWithBusy('tts', () => onGenerateTts?.(checkedLives))}
              disabled={busy !== null || remoteBusy || !serverReady || !checkedLives.length}
              className="flex items-center gap-1.5 border border-emerald-700 bg-emerald-600 px-3 py-1.5 text-[11px] font-bold text-white disabled:opacity-50"
            >
              <Volume2 className="h-3.5 w-3.5" />
              {serverReady ? 'TTS' : 'Wait...'}
            </button>

            <button
              onClick={() => void downloadCheckedCsv()}
              disabled={!checkedLives.length}
              className="flex items-center gap-1.5 border border-sky-200 bg-sky-50 px-3 py-1.5 text-[11px] font-bold text-sky-700 disabled:opacity-30"
            >
              <Download className="h-3.5 w-3.5" />
              CSV ({checkedLives.length})
            </button>

            <button
              onClick={deleteCheckedLives}
              disabled={!checkedLives.length}
              className="flex items-center gap-1.5 border border-rose-150 bg-rose-50 px-3 py-1.5 text-[11px] font-bold text-rose-600 disabled:opacity-30"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete ({checkedLives.length})
            </button>
          </div>
        )}
      </div>

      {selectedTab === 'live' && (
        <div className="relative border-b border-slate-200" title={statusLabel}>
          <div
            className={`h-1 transition-all duration-300 ${statusBarClass}`}
            style={{ width: `${statusProgress}%` }}
          />
        </div>
      )}

      {selectedTab === 'live' && (
        <div className="space-y-3 text-xs">
          {lives.map(live => {
            const expanded = !!expandedLives[live.id];
            const lines = liveSpeechLines[live.id] || [];
            const checked = checkedLives.includes(live.id);
            return (
              <div key={live.id} className="border-b border-slate-100 pb-3">
                <div className="flex cursor-pointer items-center justify-between gap-3 p-2.5 hover:bg-slate-50">
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onClick={(event) => toggleLiveCheckbox(live.id, event)}
                      onChange={() => {}}
                      className="h-3.5 w-3.5 cursor-pointer accent-rose-500"
                    />
                    <button onClick={(event) => toggleLive(live.id, event)} className="p-1 text-slate-500 hover:bg-slate-100">
                      {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <span className="shrink-0 border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] font-black text-slate-600">#{live.id}</span>
                    <span className="truncate text-[12px] font-extrabold">{live.title}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-[10px] text-slate-500">
                    <span>{live.totalLines} lines</span>
                    <span>{live.synthesizedCount}/{live.totalLines} audio</span>
                    <span className={`px-1.5 py-0.5 font-bold ${
                      live.synthesizedCount > 0 && live.synthesizedCount >= live.totalLines
                        ? 'bg-emerald-100 text-emerald-700'
                        : live.status === 'active'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-slate-100 text-slate-600'
                    }`}>
                      {live.synthesizedCount > 0 && live.synthesizedCount >= live.totalLines
                        ? 'TTS作成済み'
                        : live.status === 'active'
                          ? '生成中'
                          : live.status === 'completed'
                            ? '配信済み'
                            : '待機中'}
                    </span>
                    <button
                      type="button"
                      onClick={(event) => void downloadLiveCsv(live, event)}
                      className="inline-flex h-6 w-6 items-center justify-center border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100"
                      title={`Download CSV for live #${live.id}`}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="ml-5 mt-2 border-l-2 border-dashed border-slate-200 pl-6">
                    {lines.length ? (
                      <div className="overflow-x-auto bg-white">
                        <table className="w-full min-w-[760px] table-auto text-left text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 text-[9px] font-bold uppercase text-slate-500">
                              <th className="w-20 p-2">#</th>
                              <th className="p-2">TEXT</th>
                              <th className="w-36 p-2">KEYWORD</th>
                              <th className="w-14 p-2 text-center">CSV</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 text-[11px] text-slate-700">
                            {lines.map(line => (
                              <tr key={line.id} className="align-top hover:bg-slate-50">
                                <td className="p-2 align-top font-mono text-[9px] font-bold">
                                  <span className="mr-1">#{line.lineNo}</span>
                                  {line.isSynthesized && line.audioUrl ? (
                                    <button
                                      type="button"
                                      onClick={() => void playSpeechLineAudio(line)}
                                      className={`inline-flex items-center justify-center h-4 w-4 rounded-full ${playingAudioLineId === line.id ? 'bg-emerald-500 text-white' : 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200'}`}
                                      title={playingAudioLineId === line.id ? 'Playing...' : 'Play audio'}
                                    >
                                      <Play className="h-2.5 w-2.5" />
                                    </button>
                                  ) : null}
                                </td>
                                <td className="whitespace-pre-wrap break-words p-2 align-top font-sans text-[12px] leading-relaxed">
                                  {line.isSynthesized ? <ChunkedText text={line.text} /> : line.text}
                                </td>
                                <td className="p-2 align-top">
                                  <span className="inline-block break-words bg-slate-100 px-1 py-0.5 text-[9px]">{line.topic}</span>
                                </td>
                                <td className="p-2 align-top text-center">
                                  <button
                                    type="button"
                                    onClick={() => void copySpeechLineCsv(line, live)}
                                    className="inline-flex h-7 w-7 items-center justify-center border border-slate-200 bg-white text-slate-500 hover:border-sky-200 hover:bg-sky-50 hover:text-sky-700"
                                    title={`Copy line #${line.lineNo} as CSV`}
                                  >
                                    <Clipboard className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="p-3 text-center text-[10px] italic text-slate-400">No speech lines loaded.</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selectedTab === 'memory' && (
        <div className="overflow-x-auto bg-white">
          <table className="w-full min-w-[760px] table-auto text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-[9px] font-bold uppercase text-slate-500">
                <th className="p-3">中身</th>
                <th className="w-64 p-3">KEYWORD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-[11px] text-slate-700">
              {memoryRows.map(mem => (
                <tr key={mem.id} className="align-top hover:bg-slate-50">
                  <td className="whitespace-pre-wrap break-words p-3 font-sans text-[12px] leading-relaxed">
                    {mem.episode || mem.content || mem.text || ''}
                  </td>
                  <td className="whitespace-pre-wrap break-words p-3 font-mono text-[10px] text-slate-500">
                    {formatKeywords(mem.keywords)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedTab === 'vector' && (
        <div className="max-h-[650px] space-y-3 overflow-y-auto pr-2 font-mono text-xs">
          {vectorTree.map(({ flow, topics }) => {
            const flowOpen = expandedVectorNodes[flow.id] !== false;
            return (
              <div key={flow.id} className="border-b border-slate-100 pb-3">
                <VectorRow
                  icon={<Layers className="h-4 w-4 text-indigo-500" />}
                  label="FLOW"
                  id={flow.id}
                  text={flow.text}
                  count={topics.length}
                  open={flowOpen}
                  onToggle={() => toggleVectorNode(flow.id)}
                />
                {flowOpen && (
                  <div className="ml-5 mt-1 border-l border-slate-200 pl-5">
                    {topics.map(({ topic, styles }) => {
                      const topicOpen = expandedVectorNodes[topic.id] !== false;
                      return (
                        <div key={topic.id} className="py-1">
                          <VectorRow
                            icon={<Tag className="h-3.5 w-3.5 text-emerald-500" />}
                            label="TOPIC"
                            id={topic.id}
                            text={topic.topic || topic.text}
                            subText={topic.handling}
                            count={styles.length}
                            open={topicOpen}
                            onToggle={() => toggleVectorNode(topic.id)}
                          />
                          {topicOpen && (
                            <div className="ml-5 mt-1 border-l border-slate-100 pl-5">
                              {styles.map(style => (
                                <div key={style.id} className="flex gap-2 p-2 text-[11px] hover:bg-slate-50">
                                  <span className="shrink-0 font-bold text-amber-500">STYLE</span>
                                  <span className="shrink-0 text-slate-400">{style.id}</span>
                                  <span className="whitespace-pre-wrap break-words font-sans text-slate-700">{style.text}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <LogPopup
        open={consoleOpen}
        logs={consoleLogs}
        onClose={() => setConsoleOpen(false)}
        onClear={onClearLogs}
      />
      <button
        onClick={() => setConsoleOpen(true)}
        className="fixed bottom-4 right-4 z-[900] flex h-9 items-center gap-1.5 border border-slate-700 bg-slate-950 px-2.5 font-mono text-[10px] font-black text-white shadow-2xl hover:bg-slate-900"
        title="Open DataStudio log console"
      >
        <Terminal className="h-3.5 w-3.5 text-indigo-400" />
        LOG
        <span className="bg-slate-800 px-1 text-[9px] text-slate-400">{consoleLogs.length}</span>
      </button>
    </div>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 border-b-2 pb-2 text-xs font-bold transition ${
        active ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-800'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function VectorRow({
  icon,
  label,
  id,
  text,
  subText,
  count,
  open,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  id: string;
  text: string;
  subText?: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-start gap-2 p-2 text-left hover:bg-slate-50"
    >
      <span className="mt-0.5 text-slate-400">
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </span>
      <span className="mt-0.5">{icon}</span>
      <span className="mt-0.5 shrink-0 font-bold text-slate-500">{label}</span>
      <span className="mt-0.5 shrink-0 text-slate-400">{id}</span>
      <span className="min-w-0 flex-1">
        <span className="block whitespace-pre-wrap break-words font-sans text-[12px] font-bold text-slate-800">{text}</span>
        {subText && <span className="block whitespace-pre-wrap break-words font-sans text-[11px] text-slate-500">{subText}</span>}
      </span>
      <span className="mt-0.5 shrink-0 bg-slate-100 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">{count}</span>
    </button>
  );
}

function formatKeywords(value: any) {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value !== 'string') return String(value ?? '');
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.join(', ');
  } catch {}
  return value;
}

function toCsv(rows: any[][]) {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value: any) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Clipboard copy is not available.');
}

function LogPopup({
  open,
  logs,
  onClose,
  onClear,
}: {
  open: boolean;
  logs: ConsoleLog[];
  onClose: () => void;
  onClear: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (!open) return null;

  const latestLogs = logs.slice(-160).reverse();

  return (
    <div className="fixed bottom-5 right-5 z-[1000] w-[min(720px,calc(100vw-40px))] border border-slate-700 bg-slate-950 text-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-indigo-400" />
          <span className="font-mono text-xs font-black uppercase tracking-widest">Log Console</span>
          <span className="bg-slate-800 px-1.5 py-0.5 font-mono text-[9px] text-slate-400">{logs.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onClear} className="p-1.5 text-slate-400 hover:bg-slate-900 hover:text-rose-400" title="Clear logs">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setCollapsed(prev => !prev)} className="p-1.5 text-slate-400 hover:bg-slate-900 hover:text-white" title="Collapse logs">
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:bg-slate-900 hover:text-white" title="Close logs">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="max-h-[420px] overflow-y-auto p-3 font-mono text-[11px] leading-relaxed">
          {latestLogs.length ? latestLogs.map(log => (
            <div key={log.id} className="flex gap-2 border-b border-slate-900 py-1.5">
              <span className="shrink-0 text-slate-600">[{log.timestamp}]</span>
              <span className={`shrink-0 font-black uppercase ${logColor(log.level)}`}>{log.level}</span>
              <span className="break-words text-slate-300">{log.message}</span>
            </div>
          )) : (
            <div className="py-10 text-center italic text-slate-500">No logs yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

function logColor(level: ConsoleLog['level']) {
  if (level === 'success') return 'text-emerald-400';
  if (level === 'warn') return 'text-amber-400';
  if (level === 'error') return 'text-rose-400';
  return 'text-blue-400';
}

function splitSpeechText(text: string, maxChars = 200): string[] {
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const parts = normalized.match(/[^。！？!?、，]+[。！？!?、，]?/g) || [normalized];
  const chunks: string[] = [];
  let buffer = '';
  for (const part of parts) {
    const sentence = part.trim();
    if (!sentence) continue;
    if ((buffer + sentence).length <= maxChars) { buffer += sentence; continue; }
    if (buffer) chunks.push(buffer);
    if (sentence.length <= maxChars) { buffer = sentence; continue; }
    for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars));
    buffer = '';
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function ChunkedText({ text }: { text: string }) {
  const chunks = splitSpeechText(text);
  if (chunks.length <= 1) return <>{text}</>;
  return (
    <>
      {chunks.map((chunk, i) => (
        <span
          key={i}
          className={i % 2 === 0 ? 'bg-blue-200/60' : 'bg-blue-100/40'}
          title={`chunk ${i + 1}/${chunks.length}`}
        >
          {chunk}
        </span>
      ))}
    </>
  );
}
