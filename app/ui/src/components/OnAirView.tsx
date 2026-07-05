/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  BookmarkCheck,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListRestart,
  Play,
  SidebarClose,
  SidebarOpen,
  Square,
  Terminal,
  Trash2,
  Video,
  Volume2,
  X,
} from 'lucide-react';
import { BroadcastState, ConsoleLog, LiveStream, SpeechLine } from '../types';
import * as api from '../api';


interface OnAirViewProps {
  lives: LiveStream[];
  currentLive: LiveStream | null;
  onSelectLive: (id: string) => void;
  speechLines: SpeechLine[];
  onToggleSpeechLineSpoken: (lineId: string) => void;
  consoleLogs: ConsoleLog[];
  onClearLogs: () => void;
  onAddConsoleLog: (level: 'info' | 'warn' | 'error' | 'success', msg: string) => void;
  radioStatus: any;
  onStartRadio: () => Promise<void>;
  onStopRadio: () => Promise<void>;
  serverReady: boolean;
  obsMode?: boolean;
  serverBroadcastState?: string;
  serverMotion?: { clip: string; at: number } | null;
  serverSpeaking?: boolean;
}

export default function OnAirView({
  lives,
  currentLive,
  onSelectLive,
  speechLines,
  onToggleSpeechLineSpoken,
  consoleLogs,
  onClearLogs,
  onAddConsoleLog,
  radioStatus,
  onStartRadio,
  onStopRadio,
  serverReady,
  obsMode = false,
  serverBroadcastState = 'idle',
  serverMotion = null,
  serverSpeaking = false,
}: OnAirViewProps) {
  const [selectedLineIndex, setSelectedLineIndex] = useState(0);
  const [isScriptQueueExpanded, setIsScriptQueueExpanded] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localPlaying, setLocalPlaying] = useState(false);
  const [localPlayingIndex, setLocalPlayingIndex] = useState(-1);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopRequestedRef = useRef(false);

  const radioState = radioStatus?.state || 'stopped';
  const isServerPlaying = radioState === 'running' || radioState === 'starting';
  const isPlaying = isServerPlaying || localPlaying;
  const currentScriptNumber = radioStatus?.script?.currentNumber || 0;
  const spokenNumber = radioStatus?.script?.spokenNumber || 0;
  const currentRadioText = radioStatus?.currentText || '';
  const isSpeaking = radioStatus?.speaking || false;

  const radioLineIndex = isServerPlaying && currentScriptNumber > 0
    ? speechLines.findIndex(line => line.lineNo === currentScriptNumber)
    : -1;
  const currentLineIndex = localPlayingIndex >= 0 ? localPlayingIndex : radioLineIndex >= 0 ? radioLineIndex : selectedLineIndex;

  const broadcastState: BroadcastState =
    localPlaying || radioState === 'running' ? 'live' :
    radioState === 'starting' ? 'starting' :
    radioState === 'stopping' ? 'ending' :
    radioState === 'error' ? 'ended' :
    'ready';

  if (obsMode) {
    const showLive = serverBroadcastState === 'live';
    const obsSpeaking = isSpeaking || serverSpeaking;
    return (
      <div className="h-full w-full bg-black relative">
        <video
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${showLive ? 'opacity-0' : 'opacity-100'}`}
          src="/avatar/opening.mp4"
          autoPlay muted loop playsInline
        />
        <div className={`absolute inset-0 transition-opacity duration-300 ${showLive ? 'opacity-100' : 'opacity-0'}`}>
          <video
            className="absolute inset-0 h-full w-full object-cover"
            src="/avatar/background.mp4"
            autoPlay muted loop playsInline
          />
          <div className="absolute inset-0 z-10">
            <ClipAvatar isPlaying={showLive} speaking={showLive && obsSpeaking} obsMode triggerMotion={serverMotion} />
          </div>
        </div>
      </div>
    );
  }

  const currentLine = speechLines[currentLineIndex];
  const selectedLiveHasAudio = !!currentLive
    && currentLive.totalLines > 0
    && currentLive.synthesizedCount > 0
    && currentLive.synthesizedCount >= currentLive.totalLines
    && speechLines.length > 0
    && speechLines.every(line => line.isSynthesized && !!line.audioUrl);

  const playAudioUrl = (url: string) => new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.addEventListener('ended', () => resolve(), { once: true });
    audio.addEventListener('error', () => reject(new Error('HTMLAudioElement error')), { once: true });
    audio.play().catch(reject);
  });

  const playSelectedLiveInBrowser = async () => {
    if (!selectedLiveHasAudio) throw new Error('TTS済みwavが揃っていません。');
    stopRequestedRef.current = false;
    setLocalPlaying(true);
    await api.broadcastTransition('live').catch(() => {});
    await new Promise(r => setTimeout(r, 600));
    onAddConsoleLog('info', `Browser audio playback started for live #${currentLive?.id}.`);
    try {
      for (let index = 0; index < speechLines.length; index++) {
        if (stopRequestedRef.current) break;
        const line = speechLines[index];
        const urls = line.audioUrls?.length ? line.audioUrls : line.audioUrl ? [line.audioUrl] : [];
        if (!urls.length) throw new Error(`Line #${line.lineNo} has no wav URL.`);
        setLocalPlayingIndex(index);
        setSelectedLineIndex(index);
        for (const url of urls) {
          if (stopRequestedRef.current) break;
          await api.broadcastSpeaking(true).catch(() => {});
          try {
            await playAudioUrl(url);
          } finally {
            await api.broadcastSpeaking(false).catch(() => {});
          }
        }
        if (index < speechLines.length - 1 && !stopRequestedRef.current) {
          const motionClip = pickWeightedMotion(null);
          api.broadcastMotion(motionClip).catch(() => {});
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));
        }
      }
    } finally {
      audioRef.current = null;
      setLocalPlaying(false);
      setLocalPlayingIndex(-1);
      stopRequestedRef.current = false;
      api.broadcastSpeaking(false).catch(() => {});
      api.broadcastTransition('idle').catch(() => {});
    }
  };

  const stopBrowserAudio = () => {
    stopRequestedRef.current = true;
    audioRef.current?.pause();
    if (audioRef.current) audioRef.current.currentTime = 0;
    audioRef.current = null;
    setLocalPlaying(false);
    setLocalPlayingIndex(-1);
    api.broadcastSpeaking(false).catch(() => {});
    api.broadcastTransition('idle').catch(() => {});
  };

  useEffect(() => {
    if (isScriptQueueExpanded && activeLineRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentLineIndex, isScriptQueueExpanded]);

  useEffect(() => {
    setSelectedLineIndex(0);
  }, [currentLive?.id]);

  return (
    <div className="space-y-5" id="onair-console-suite">
      <div className="flex flex-col gap-4 bg-slate-50 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${broadcastState === 'live' ? 'bg-rose-500 animate-pulse' : 'bg-amber-400'}`} />
            <h3 className="font-mono text-xs font-bold uppercase tracking-widest text-slate-800">Live Broadcast Studio</h3>
          </div>

          <div className="flex items-center gap-1.5 border border-slate-200 bg-white px-2.5 py-1.5">
            <Video className="h-3.5 w-3.5 text-indigo-500" />
            <select
              value={currentLive?.id || ''}
              onChange={(event) => onSelectLive(event.target.value)}
              className="cursor-pointer border-none bg-transparent text-[11px] font-bold text-slate-800 outline-none"
            >
              {lives.filter(live => live.totalLines > 0 && live.synthesizedCount >= live.totalLines).map(live => (
                <option key={live.id} value={live.id}>
                  #{live.id} {live.title} ({live.totalLines} lines)
                </option>
              ))}
            </select>
          </div>

        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1 border border-slate-200 bg-white p-1">
            <button
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                try {
                  void playSelectedLiveInBrowser().catch((error: any) => {
                    onAddConsoleLog('error', `Failed to start radio: ${error.message}`);
                  });
                } catch (error: any) {
                  onAddConsoleLog('error', `Failed to start radio: ${error.message}`);
                } finally {
                  setBusy(false);
                }
              }}
              disabled={isPlaying || busy || !serverReady || !selectedLiveHasAudio}
              className="flex min-w-[70px] cursor-pointer items-center justify-center gap-1 border border-indigo-700 bg-indigo-600 px-3 py-1.5 text-[11px] font-black text-white transition disabled:border-transparent disabled:bg-transparent disabled:text-slate-400"
              title={selectedLiveHasAudio ? 'Play selected live audio' : 'TTS済みwavが揃っていないLiveは再生できません'}
            >
              <Play className="h-3.5 w-3.5" />
              <span>{!serverReady ? 'WAIT' : selectedLiveHasAudio ? 'PLAY' : 'NO WAV'}</span>
            </button>
            <button
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                const timer = setTimeout(() => setBusy(false), 15000);
                try {
                  if (localPlaying) {
                    stopBrowserAudio();
                    onAddConsoleLog('warn', 'Browser audio playback stopped.');
                  } else {
                    await onStopRadio();
                    onAddConsoleLog('warn', 'Radio playback stopped.');
                  }
                } catch (error: any) {
                  onAddConsoleLog('error', `Failed to stop radio: ${error.message}`);
                } finally {
                  clearTimeout(timer);
                  setBusy(false);
                }
              }}
              disabled={!isPlaying || busy || !serverReady}
              className="flex min-w-[70px] cursor-pointer items-center justify-center gap-1 border border-slate-200 bg-slate-100 px-3 py-1.5 text-[11px] font-black text-slate-700 transition disabled:border-transparent disabled:bg-transparent disabled:text-slate-400"
            >
              <Square className="h-3 w-3" />
              <span>STOP</span>
            </button>
          </div>

          <button
            onClick={() => setIsScriptQueueExpanded(prev => !prev)}
            className="flex min-w-[120px] cursor-pointer items-center justify-center gap-1.5 border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs font-bold text-slate-700 transition hover:bg-slate-50"
          >
            {isScriptQueueExpanded ? <SidebarClose className="h-4 w-4" /> : <SidebarOpen className="h-4 w-4" />}
            <span>QUEUE</span>
          </button>

          <button
            onClick={() => window.open('/?obs', 'kawaiilive-obs', 'width=960,height=540')}
            className="flex cursor-pointer items-center gap-1.5 border border-indigo-500 bg-indigo-600 px-3 py-1.5 font-mono text-xs font-bold text-white transition hover:bg-indigo-500"
          >
            <ExternalLink className="h-4 w-4" />
            <span>PREVIEW</span>
          </button>

          <button
            onClick={() => setConsoleOpen(true)}
            className="flex cursor-pointer items-center gap-1.5 border border-slate-700 bg-slate-900 px-3 py-1.5 font-mono text-xs font-bold text-white transition hover:bg-slate-800"
          >
            <Terminal className="h-4 w-4" />
            <span>LOG</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col items-stretch gap-5 lg:flex-row">
        <div className={`flex flex-col gap-4 transition-all duration-300 ${isScriptQueueExpanded ? 'lg:w-[65%]' : 'w-full'}`}>
          <div className="flex h-full flex-col gap-4 bg-slate-50 p-4 lg:p-5">
            <div className="relative w-full bg-white p-4 lg:p-5">
              <div className="absolute -top-3 left-5 flex items-center gap-1.5 bg-indigo-600 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
                <Volume2 className="h-3 w-3" />
                <span>Now Speaking</span>
              </div>
              <p className="whitespace-pre-wrap break-words pt-2 font-sans text-sm font-bold italic leading-relaxed text-slate-850 xl:text-base">
                {isPlaying ? (currentRadioText || currentLine?.text || 'Waiting for audio...') : (currentLine?.text || 'No speech line selected.')}
              </p>
            </div>

            <div className="flex flex-wrap gap-1.5 bg-white p-3">
              {MOTION_BUTTONS.map(([label, clip, icon]) => (
                <button
                  key={label}
                  onClick={() => api.broadcastMotion(clip)}
                  className="rounded-md bg-slate-700 px-2.5 py-1.5 text-xs font-bold text-slate-300 shadow hover:bg-slate-600"
                >
                  {icon} {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {isScriptQueueExpanded && (
          <div className="flex shrink-0 animate-fade-in flex-col gap-4 bg-slate-50 p-4 lg:w-[35%]">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-1.5">
                <BookmarkCheck className="h-4 w-4 text-indigo-500" />
                <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-slate-800">Script Queue</h3>
              </div>
              <button
                onClick={() => {
                  setSelectedLineIndex(0);
                  onAddConsoleLog('info', 'Script pointer reset.');
                }}
                className="p-1 text-slate-500 hover:text-slate-800"
                title="Reset queue"
              >
                <ListRestart className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="max-h-[620px] min-h-[300px] flex-1 space-y-2 overflow-y-auto pr-1">
              {speechLines.map((line, index) => {
                const active = index === currentLineIndex;
                return (
                  <div
                    key={line.id}
                    ref={active ? activeLineRef : null}
                    onClick={() => setSelectedLineIndex(index)}
                    className={`cursor-pointer border p-3 transition ${
                      active ? 'border-indigo-500 bg-indigo-50 text-indigo-900' : 'border-slate-100 bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] font-black">#{line.lineNo}</span>
                      <span className={`text-[9px] font-bold ${line.isSynthesized ? 'text-emerald-600' : 'text-slate-400'}`}>
                        {line.isSynthesized ? 'AUDIO' : 'NO AUDIO'}
                      </span>
                    </div>
                    <p className="line-clamp-3 break-words font-sans text-[11px] leading-relaxed">{line.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <LogPopup
        open={consoleOpen}
        logs={consoleLogs}
        onClose={() => setConsoleOpen(false)}
        onClear={onClearLogs}
      />
    </div>
  );
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

function SubtitleOverlay({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="absolute bottom-12 left-4 right-4 z-30 text-center">
      <span className="inline-block max-w-full truncate rounded bg-black/70 px-4 py-1.5 text-sm font-bold text-white shadow-lg">
        {text}
      </span>
    </div>
  );
}

type ClipDef = { frameCount: number; loop: boolean; pingpong?: boolean; next: string | null; startFrame?: number };
const MOTION_BUTTONS: [string, string, string][] = [
  ['speak', 'mouth_talking_loop', '🗣'],
  ['blink', 'idle_blink_oneshot', '😌'],
  ['eyesShut', 'blink_closed_hold', '🙈'],
  ['react', 'expression_react', '😲'],
  ['think', 'head_tilt', '🤔'],
  ['look', 'side_turn_and_blink', '👀'],
  ['shake', 'shake_neutral_start', '🙅'],
  ['angry', 'angry_neutral_start', '😤'],
  ['wave', 'wave_neutral_start', '👋'],
  ['surprise', 'surprise_neutral_start', '😱'],
  ['doze', 'doze_neutral_start', '😴'],
  ['breathe', 'breathe_idle_loop', '🌬'],
  ['glance', 'hand_to_face_glance', '🤭'],
  ['stretch', 'stretch_motion', '🙆'],
  ['shh', 'shh_raise_motion', '🤫'],
  ['idle', 'idle_open_loop', '●'],
];

const CLIP_META: Record<string, ClipDef> = {
  // --- original ---
  neutral_idle:        { frameCount: 25, loop: true,  next: null },
  talking_cycle:       { frameCount: 49, loop: true,  next: null },
  center_soft_blink:   { frameCount: 19, loop: false, next: 'neutral_idle' },
  side_turn_and_blink: { frameCount: 37, loop: false, next: 'return_from_side' },
  return_from_side:    { frameCount: 19, loop: false, next: 'neutral_idle' },
  expression_react:    { frameCount: 19, loop: false, pingpong: true, next: 'neutral_idle' },
  head_tilt:           { frameCount: 31, loop: false, pingpong: true, next: 'neutral_idle' },
  neutral_return:      { frameCount: 12, loop: false, next: 'neutral_idle' },
  // --- head shake ---
  shake_neutral_start: { frameCount: 25, startFrame: 1, loop: false, next: 'shake_left_dip' },
  shake_left_dip:      { frameCount: 31, startFrame: 1, loop: false, next: 'shake_right_return' },
  shake_right_return:  { frameCount: 31, startFrame: 1, loop: false, next: 'shake_settle' },
  shake_settle:        { frameCount: 37, startFrame: 1, loop: false, next: 'shake_neutral_end' },
  shake_neutral_end:   { frameCount: 24, startFrame: 1, loop: false, next: 'neutral_idle' },
  // --- angry ---
  angry_neutral_start: { frameCount: 25, startFrame: 1, loop: false, next: 'angry_turn_side' },
  angry_turn_side:     { frameCount: 43, startFrame: 1, loop: false, next: 'angry_hold_side' },
  angry_hold_side:     { frameCount: 19, startFrame: 1, loop: false, next: 'angry_return_neutral' },
  angry_return_neutral:{ frameCount: 42, startFrame: 1, loop: false, next: 'neutral_idle' },
  angry_blink:         { frameCount: 13, startFrame: 1, loop: false, next: 'angry_hold_side' },
  // --- wave ---
  wave_neutral_start:  { frameCount: 31, startFrame: 1, loop: false, next: 'wave_raise' },
  wave_raise:          { frameCount: 31, startFrame: 1, loop: false, next: 'wave_loop' },
  wave_loop:           { frameCount: 97, startFrame: 1, loop: false, next: 'wave_lower' },
  wave_lower:          { frameCount: 37, startFrame: 1, loop: false, next: 'wave_neutral_end' },
  wave_neutral_end:    { frameCount: 48, startFrame: 1, loop: false, next: 'neutral_idle' },
  // --- big surprise ---
  surprise_neutral_start:{ frameCount: 31, startFrame: 1, loop: false, next: 'surprise_pop' },
  surprise_pop:        { frameCount: 37, startFrame: 1, loop: false, next: 'surprise_settle' },
  surprise_settle:     { frameCount: 37, startFrame: 1, loop: false, next: 'surprise_neutral_end' },
  surprise_neutral_end:{ frameCount: 60, startFrame: 1, loop: false, next: 'neutral_idle' },
  // --- dozing ---
  doze_neutral_start:  { frameCount: 49, startFrame: 1, loop: false, next: 'doze_eyes_close' },
  doze_eyes_close:     { frameCount: 37, startFrame: 1, loop: false, next: 'doze_sleep_loop' },
  doze_sleep_loop:     { frameCount: 49, startFrame: 1, loop: false, next: 'startle_wake' },
  startle_wake:        { frameCount: 49, startFrame: 1, loop: false, next: 'startle_settle' },
  startle_settle:      { frameCount: 37, startFrame: 1, loop: false, next: 'doze_neutral_end' },
  doze_neutral_end:    { frameCount: 24, startFrame: 1, loop: false, next: 'neutral_idle' },
  // --- breathing / glancing ---
  breathe_idle_loop:   { frameCount: 84, startFrame: 1, loop: true, next: null },
  hand_to_face_glance: { frameCount: 60, startFrame: 1, loop: false, pingpong: true, next: 'neutral_idle' },
  soft_blink_breathe:  { frameCount: 96, startFrame: 1, loop: false, next: 'neutral_idle' },
  // --- mouth talking loop (speaking_mouth: 10s proper mouth-flap) ---
  mouth_talking_loop:  { frameCount: 240, startFrame: 0, loop: true, next: null },
  // --- stretch / sigh ---
  stretch_motion:      { frameCount: 96, startFrame: 1, loop: false, next: 'neutral_end_stretch' },
  sigh_settle:         { frameCount: 144, startFrame: 1, loop: false, next: 'neutral_end_stretch' },
  neutral_end_stretch: { frameCount: 24, startFrame: 1, loop: false, next: 'neutral_idle' },
  // --- idle_blink (default-state idle + blink) ---
  idle_open_loop:      { frameCount: 25, startFrame: 0, loop: true,  next: null },
  idle_blink_oneshot:  { frameCount: 56, startFrame: 0, loop: false, next: 'idle_open_loop' },
  idle_open_end:       { frameCount: 15, startFrame: 0, loop: false, next: 'idle_open_loop' },
  blink_closed_hold:   { frameCount: 41, startFrame: 1, loop: false, next: 'blink_return_open' },
  blink_return_open:   { frameCount: 24, startFrame: 1, loop: false, next: 'idle_open_loop' },
  // --- shh / whisper ---
  shh_raise_motion:    { frameCount: 24, startFrame: 0, loop: false, next: 'shh_whisper_hold' },
  shh_whisper_hold:    { frameCount: 48, startFrame: 0, loop: false, next: 'shh_return_settle' },
  shh_return_settle:   { frameCount: 168, startFrame: 0, loop: false, next: 'idle_open_loop' },
};
const CLIP_FPS = 24;

// home/default idle and speaking clips (new purpose-built assets)
const DEFAULT_IDLE = 'idle_open_loop';
const TALK_CLIP = 'mouth_talking_loop';
// any clip chaining back to the old 'neutral_idle' homes to the new default idle
const homeClip = (name: string | null) => (!name || name === 'neutral_idle' ? DEFAULT_IDLE : name);
const AUTO_MOTIONS: { clip: string; weight: number }[] = [
  { clip: 'soft_blink_breathe', weight: 5 },
  { clip: 'head_tilt', weight: 3 },
  { clip: 'hand_to_face_glance', weight: 2 },
  { clip: 'expression_react', weight: 1 },
];
function pickWeightedMotion(exclude?: string | null): string {
  const pool = exclude ? AUTO_MOTIONS.filter(m => m.clip !== exclude) : AUTO_MOTIONS;
  const total = pool.reduce((s, m) => s + m.weight, 0);
  let r = Math.random() * total;
  for (const m of pool) { r -= m.weight; if (r <= 0) return m.clip; }
  return pool[0].clip;
}

function ClipAvatar({ isPlaying, speaking, obsMode = false, triggerMotion }: { isPlaying: boolean; speaking: boolean; obsMode?: boolean; triggerMotion?: { clip: string; at: number } | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ clip: DEFAULT_IDLE, frame: 0, dir: 1 as 1 | -1 });
  const cacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const rafRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const blinkTimerRef = useRef(0);
  const autoMotionTimerRef = useRef(0);
  const isPlayingRef = useRef(isPlaying);
  const speakingRef = useRef(speaking);
  const wasSpeakingRef = useRef(false);
  const manualOverrideUntilRef = useRef(0);
  const lastSpeakingAtRef = useRef(0);
  const lastAutoMotionClipRef = useRef<string | null>(null);
  const [activeLabel, setActiveLabel] = useState('idle');

  isPlayingRef.current = isPlaying;
  speakingRef.current = speaking;

  useEffect(() => {
    let running = true;
    const frameDuration = 1000 / CLIP_FPS;

    const preloadClip = (name: string) => {
      const meta = CLIP_META[name];
      if (!meta) return;
      for (let i = 0; i < meta.frameCount; i++) {
        const key = `${name}/${i}`;
        if (!cacheRef.current.has(key)) {
          const img = new Image();
          const sf = CLIP_META[name]?.startFrame ?? 0;
          img.src = `/avatar/clips/${name}/frame_${String(i + sf).padStart(3, '0')}.png`;
          cacheRef.current.set(key, img);
        }
      }
    };

    Object.keys(CLIP_META).forEach(preloadClip);

    const scheduleNextBlink = () => {
      blinkTimerRef.current = window.setTimeout(() => {
        if (!running) return;
        const s = stateRef.current;
        if (s.clip === DEFAULT_IDLE) {
          s.clip = 'idle_blink_oneshot';
          s.frame = 0;
          s.dir = 1;
        }
        scheduleNextBlink();
      }, (3 + Math.random() * 4) * 1000);
    };
    scheduleNextBlink();

    const scheduleAutoMotion = () => {
      autoMotionTimerRef.current = window.setTimeout(() => {
        if (!running) return;
        const s = stateRef.current;
        const manualActive = Date.now() < manualOverrideUntilRef.current;
        const silenceMs = Date.now() - lastSpeakingAtRef.current;
        if (s.clip === DEFAULT_IDLE && !speakingRef.current && !manualActive && silenceMs > 1500) {
          const pick = pickWeightedMotion(lastAutoMotionClipRef.current);
          lastAutoMotionClipRef.current = pick;
          s.clip = pick;
          s.frame = 0;
          s.dir = 1;
        }
        scheduleAutoMotion();
      }, (8 + Math.random() * 12) * 1000);
    };
    scheduleAutoMotion();

    const draw = (now: number) => {
      if (!running) return;
      const elapsed = now - lastFrameTimeRef.current;
      if (elapsed >= frameDuration) {
        lastFrameTimeRef.current = now - (elapsed % frameDuration);
        const s = stateRef.current;
        const meta = CLIP_META[s.clip];
        if (meta) {
          const key = `${s.clip}/${s.frame}`;
          const img = cacheRef.current.get(key);
          const canvas = canvasRef.current;
          if (img && img.complete && canvas) {
            if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth;
            if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d')!;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);

            if (speakingRef.current && !wasSpeakingRef.current) {
              manualOverrideUntilRef.current = 0;
              s.clip = TALK_CLIP;
              s.frame = Math.floor(Math.random() * Math.min(12, CLIP_META[TALK_CLIP]?.frameCount ?? 1));
              s.dir = 1;
              setActiveLabel('speak');
            } else if (!speakingRef.current && wasSpeakingRef.current && s.clip === TALK_CLIP) {
              s.clip = DEFAULT_IDLE; s.frame = 0; s.dir = 1;
              lastSpeakingAtRef.current = Date.now();
              setActiveLabel('idle');
            }
            wasSpeakingRef.current = speakingRef.current;
          }
          s.frame += s.dir;
          if (meta.loop) {
            if (s.frame >= meta.frameCount) {
              s.frame = 0;
              s.dir = 1;
            }
          } else if (meta.pingpong && s.frame >= meta.frameCount) {
            s.dir = -1;
            s.frame = meta.frameCount - 2;
          } else if (meta.pingpong && s.dir === -1 && s.frame < 0) {
            s.clip = homeClip(meta.next);
            s.frame = 0;
            s.dir = 1;
            if (s.clip === DEFAULT_IDLE) { setActiveLabel('idle'); }
          } else if (s.frame >= meta.frameCount) {
            s.clip = homeClip(meta.next);
            s.frame = 0;
            s.dir = 1;
            if (s.clip === DEFAULT_IDLE) { setActiveLabel('idle'); }
          }
        }
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      clearTimeout(blinkTimerRef.current);
      clearTimeout(autoMotionTimerRef.current);
    };
  }, []);

  const playClip = (clip: string, label: string) => {
    stateRef.current.clip = clip;
    stateRef.current.frame = 0;
    stateRef.current.dir = 1;
    const meta = CLIP_META[clip];
    if (clip === DEFAULT_IDLE || clip === TALK_CLIP || (meta?.loop && !meta?.next)) {
      manualOverrideUntilRef.current = 0;
    } else {
      const durationMs = meta ? Math.min((meta.frameCount / CLIP_FPS) * 1000, 4000) : 1500;
      manualOverrideUntilRef.current = Date.now() + durationMs;
    }
    setActiveLabel(label);
  };

  const lastMotionAtRef = useRef(0);
  useEffect(() => {
    if (!triggerMotion || triggerMotion.at <= lastMotionAtRef.current) return;
    lastMotionAtRef.current = triggerMotion.at;
    playClip(triggerMotion.clip, triggerMotion.clip);
  }, [triggerMotion]);

  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, px: 0, py: 0 });

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    draggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const ds = dragStartRef.current;
    setPos({ x: ds.px + e.clientX - ds.x, y: ds.py + e.clientY - ds.y });
  };
  const onPointerUp = () => { draggingRef.current = false; };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.max(0.3, Math.min(3, s - e.deltaY * 0.001)));
  };

  return (
    <div
      className={`relative flex h-full w-full items-center justify-center bg-transparent z-10 ${obsMode ? '' : 'cursor-grab active:cursor-grabbing'}`}
      aria-label="ZIPちゃん"
      onPointerDown={obsMode ? undefined : onPointerDown}
      onPointerMove={obsMode ? undefined : onPointerMove}
      onPointerUp={obsMode ? undefined : onPointerUp}
      onWheel={obsMode ? undefined : onWheel}
    >
      <canvas
        ref={canvasRef}
        className={`max-h-[620px] object-contain ${isPlaying ? '' : ''}`}
        style={{
          transform: obsMode ? undefined : `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
          transformOrigin: 'center center',
        }}
      />
      {!obsMode && (
        <div className="absolute right-3 top-3 z-50 flex flex-wrap gap-1">
          {MOTION_BUTTONS.map(([label, clip, icon]) => (
            <button
              key={label}
              onClick={() => playClip(clip, label)}
              className={`rounded-md px-2 py-1 text-xs font-bold shadow ${activeLabel === label ? 'bg-indigo-500 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
            >
              {icon}
            </button>
          ))}
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

