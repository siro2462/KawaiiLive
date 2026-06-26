/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type BroadcastState =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'starting'
  | 'live'
  | 'pausing'
  | 'paused'
  | 'ending'
  | 'ended';

export interface LiveStream {
  id: string;
  title: string;
  date: string;
  durationMinutes: number;
  status: 'completed' | 'queued' | 'active';
  totalLines: number;
  synthesizedCount: number;
}

export interface SpeechLine {
  id: string;
  lineNo: number;
  memoryId: string;
  text: string;
  speaker: 'avatar' | 'system' | 'narrator';
  isSpoken: boolean;
  isSynthesized: boolean;
  audioUrl?: string;
  audioUrls?: string[];
  synthesisTimeMs: number;
  characterCount: number;
  topic: string;
  sentiment: 'positive' | 'neutral' | 'negative' | 'excited';
  vectorX: number; // For PCA/t-SNE vector rendering
  vectorY: number; // For PCA/t-SNE vector rendering
}

export interface ChatMessage {
  id: string;
  timestamp: string;
  user: string;
  message: string;
  role: 'system' | 'npc' | 'viewer';
  sentiment: 'positive' | 'neutral' | 'negative' | 'excited';
}

export interface VectorItem {
  id: string;
  type: 'style' | 'topic' | 'flow';
  text: string;
  sourceId?: string;
  flowId?: string;
  topicId?: string;
  topic?: string;
  handling?: string;
  dimensions: number[];
  x: number; // projected coordinate
  y: number; // projected coordinate
  similarity: number;
}

export interface ConsoleLog {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface DatabaseTable {
  name: string;
  rowCount: number;
  columns: string[];
  rows: any[];
}
