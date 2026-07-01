import { LiveStream, SpeechLine, DatabaseTable, VectorItem } from './types';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `HTTP ${res.status}`);
  }
  return res.json();
}

function mapLiveStatus(status: string): 'completed' | 'queued' | 'active' {
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'active' || status === 'live' || status === 'playing') return 'active';
  return 'queued';
}

export async function fetchLives(): Promise<LiveStream[]> {
  const data = await fetchJson<{ ok: boolean; lives: any[] }>('/api/lives');
  return data.lives.map(lv => ({
    id: String(lv.id),
    title: lv.title || '',
    date: lv.createdAt ? lv.createdAt.split('T')[0] : '',
    durationMinutes: 0,
    status: mapLiveStatus(lv.status),
    totalLines: lv.totalLines ?? 0,
    synthesizedCount: lv.audioLines ?? 0,
  }));
}

export async function fetchBackgroundVideos(): Promise<{ id: string; label: string; url: string }[]> {
  const data = await fetchJson<{ ok: boolean; videos: { id: string; label: string; url: string }[] }>('/api/background-videos');
  return data.videos || [];
}

export async function fetchSpeechLines(liveId: number): Promise<SpeechLine[]> {
  const data = await fetchJson<{ ok: boolean; rows: any[]; total: number }>(
    `/api/live/lines?liveId=${liveId}`
  );
  return data.rows.map((row, idx) => ({
    id: String(row.id),
    lineNo: row.sequence_no ?? (idx + 1),
    memoryId: row.memory_id || '',
    text: row.text || '',
    speaker: 'avatar' as const,
    isSpoken: !!row.spoken_at,
    isSynthesized: !!(row.audio_path && row.audio_path !== ''),
    audioUrl: row.audio_url || '',
    audioUrls: Array.isArray(row.audio_urls) ? row.audio_urls : (row.audio_url ? [row.audio_url] : []),
    synthesisTimeMs: 0,
    characterCount: (row.text || '').length,
    topic: row.memory_keywords || '',
    sentiment: 'neutral' as const,
    vectorX: 0,
    vectorY: 0,
  }));
}

export async function fetchSqliteTables(): Promise<DatabaseTable[]> {
  const catalog = await fetchJson<{ databases: any[] }>('/api/sqlite');
  const tables: DatabaseTable[] = [];
  for (const db of catalog.databases) {
    for (const table of db.tables) {
      const tableData = await fetchJson<{ rows: any[]; total: number; columns: any[] }>(
        `/api/sqlite/table?db=${db.id}&table=${table.name}&limit=500`
      );
      tables.push({
        name: table.name,
        rowCount: tableData.total,
        columns: tableData.columns.map((c: any) => c.name),
        rows: tableData.rows,
      });
    }
  }
  return tables;
}

export async function fetchVectors(dbName: string): Promise<VectorItem[]> {
  const data = await fetchJson<{ db: string; results: any[] }>(`/api/vector/table?db=${dbName}`);
  return data.results.map(r => {
    const d = r.data || {};
    let text = '';
    if (d.flow) {
      text = String(d.flow).split('\n')[0] || String(d.flow).slice(0, 120);
    } else if (d.topic) {
      text = String(d.topic);
    } else if (d.text) {
      text = String(d.text);
    } else if (d.keywords) {
      const kw = Array.isArray(d.keywords) ? d.keywords.join(', ') : String(d.keywords);
      text = kw;
    } else if (d.episode) {
      text = String(d.episode).slice(0, 120);
    }
    if (!text) text = JSON.stringify(d).slice(0, 100);
    return {
      id: String(r.id),
      type: dbName as 'style' | 'topic' | 'flow',
      text,
      sourceId: d.source_id ? String(d.source_id) : undefined,
      flowId: d.flow_id ? String(d.flow_id) : undefined,
      topicId: d.topic_id ? String(d.topic_id) : undefined,
      topic: d.topic ? String(d.topic) : undefined,
      handling: d.handling ? String(d.handling) : undefined,
      dimensions: Array.isArray(d.embedding) ? d.embedding : [],
      x: 0,
      y: 0,
      similarity: 0,
    };
  });
}

export async function fetchAllVectors(): Promise<VectorItem[]> {
  const [flow, topic, style] = await Promise.all([
    fetchVectors('flow').catch(() => []),
    fetchVectors('topic').catch(() => []),
    fetchVectors('style').catch(() => []),
  ]);
  return [...flow, ...topic, ...style];
}

export async function fetchMemories(): Promise<any[]> {
  const data = await fetchJson<{ memories: any[] }>('/api/memories');
  return data.memories;
}

export async function deleteLives(ids: number[]): Promise<any> {
  return fetchJson('/api/live/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ liveIds: ids }),
  });
}

export async function downloadLiveCsv(liveId: number): Promise<void> {
  const res = await fetch(`/api/live/csv?liveId=${liveId}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `live-${liveId}.csv`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function prepareScript(minutes: number, count: number = 1): Promise<any> {
  return fetchJson('/api/script/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes, count }),
  });
}

export async function synthesizeTts(liveId: number): Promise<any> {
  return fetchJson('/api/live/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ liveId }),
  });
}

export async function startRadio(sourceMode: string = 'chatter', liveId?: number): Promise<any> {
  return fetchJson('/api/radio/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceMode, liveId }),
  });
}

export async function stopRadio(): Promise<any> {
  return fetchJson('/api/radio/stop', { method: 'POST' });
}

export async function emergencyStopRadio(): Promise<any> {
  return fetchJson('/api/radio/emergency-stop', { method: 'POST' });
}

export async function fetchStatus(): Promise<{
  ollama: boolean;
  radio: any;
  broadcast: any;
  obs: any;
  chatLog: any[];
  scriptLlmLog: any[];
}> {
  return fetchJson('/api/status');
}

export async function broadcastTransition(next: string): Promise<any> {
  return fetchJson('/api/broadcast/transition', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ next }),
  });
}

export async function broadcastSpeaking(speaking: boolean): Promise<any> {
  return fetchJson('/api/broadcast/speaking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speaking }),
  });
}

export async function broadcastMotion(clip: string): Promise<any> {
  return fetchJson('/api/broadcast/motion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clip }),
  });
}

export async function restartServer(): Promise<void> {
  await fetchJson('/api/server/restart', { method: 'POST' });
}

export async function stopServer(): Promise<void> {
  await fetchJson('/api/server/stop', { method: 'POST' });
}

export async function clearLogs(): Promise<void> {
  await fetchJson('/api/logs/clear', { method: 'POST' });
}
