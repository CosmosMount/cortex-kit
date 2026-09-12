import { SampleBatch } from './types';

export interface RecordedRow { elapsedSeconds: number; timestampNs: number; streamEpoch: number; values: number[]; }
export interface CsvTable { headers: string[]; rows: Array<Array<number | null>>; }
export interface Curve { name: string; points: Array<[number, number | null]>; }

export function validateSampleRate(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error('采样频率必须为 1–100000 S/s 的整数。');
  }
}

/** Select real source frames on a time grid. Never interpolate or repeat values. */
export class FrameSampler {
  private firstNs?: number;
  private lastNs = -Infinity;
  private nextNs = -Infinity;
  private source?: string;
  count = 0;
  elapsedSeconds = 0;
  constructor(readonly ids: string[], readonly requestedHz: number) {
    validateSampleRate(requestedHz);
    if (!ids.length || new Set(ids).size !== ids.length) { throw new Error('请选择不重复的采样变量。'); }
  }
  accept(batch: SampleBatch): RecordedRow[] {
    const indexes = this.ids.map(id => batch.channelIds.indexOf(id));
    if (indexes.some(index => index < 0)) { return []; } // Other acquisition group.
    const source = `${batch.sessionId}:${batch.programGeneration}`;
    if (this.source && source !== this.source) { throw new Error('目标会话或固件已改变，已停止当前记录。'); }
    this.source = source;
    if (batch.values.length !== batch.channelIds.length * batch.sampleCount) { throw new Error('采样数据长度不一致。'); }
    const result: RecordedRow[] = [];
    const interval = 1e9 / this.requestedHz;
    for (let sample = 0; sample < batch.sampleCount; sample++) {
      const timestampNs = Math.round(batch.startTimestampNs + sample * batch.samplePeriodNs);
      if (!Number.isSafeInteger(timestampNs) || timestampNs < 0) { throw new Error('采样时间戳超出支持范围。'); }
      if (timestampNs <= this.lastNs || timestampNs + 0.5 < this.nextNs) { continue; }
      this.firstNs ??= timestampNs;
      this.lastNs = timestampNs;
      this.nextNs = this.firstNs + (Math.floor((timestampNs - this.firstNs) / interval) + 1) * interval;
      this.elapsedSeconds = (timestampNs - this.firstNs) / 1e9;
      this.count++;
      result.push({ elapsedSeconds: this.elapsedSeconds, timestampNs, streamEpoch: batch.streamEpoch,
        values: indexes.map(index => batch.values[sample * batch.channelIds.length + index]) });
    }
    return result;
  }
  get actualHz(): number { return this.elapsedSeconds > 0 ? (this.count - 1) / this.elapsedSeconds : 0; }
}

export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
export function csvHeader(names: string[]): string {
  const headers = ['elapsed_s', 'timestamp_ns', 'stream_epoch'];
  for (const name of names) {
    let unique = name;
    for (let suffix = 2; headers.includes(unique); suffix++) { unique = `${name} (${suffix})`; }
    headers.push(unique);
  }
  return '\uFEFF' + headers.map(csvCell).join(',') + '\r\n';
}
export function csvRows(rows: RecordedRow[]): string {
  return rows.map(row => [row.elapsedSeconds.toFixed(9), row.timestampNs, row.streamEpoch, ...row.values].join(',') + '\r\n').join('');
}

/** RFC-style quoted fields, BOM, CRLF/LF; bounded to keep malformed imports manageable. */
export function parseCsv(text: string): CsvTable {
  if (text.length > 64 * 1024 * 1024) { throw new Error('CSV 最大支持 64 MB。'); }
  const records: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false, cells = 0;
  const pushField = () => {
    if (++cells > 2_000_000 || row.length >= 256) { throw new Error('CSV 最大支持 200 万个单元格、256 列。'); }
    row.push(field); field = ''; closed = false;
  };
  const pushRow = () => { pushField(); if (row.some(value => value.trim() !== '')) { records.push(row); } row = []; };
  text = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quoted) {
      if (ch === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closed = true; }
      } else { field += ch; }
    } else if (ch === ',') { pushField(); }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[index + 1] === '\n') { index++; } pushRow(); }
    else if (ch === '"' && field === '' && !closed) { quoted = true; }
    else if (closed || ch === '"') { throw new Error(`CSV 第 ${records.length + 1} 行引号格式不正确。`); }
    else { field += ch; }
  }
  if (quoted) { throw new Error('CSV 引号未闭合。'); }
  if (field || row.length || closed) { pushRow(); }
  const headers = records.shift()?.map(value => value.trim());
  if (!headers || headers.length < 2 || !records.length) { throw new Error('CSV 需要表头、时间列和至少一行数值。'); }
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) { throw new Error('CSV 列名不能为空或重复。'); }
  const rows = records.map((values, index) => {
    if (values.length !== headers.length) { throw new Error(`CSV 第 ${index + 2} 行的列数与表头不一致。`); }
    return values.map(value => {
      if (!value.trim()) { return null; }
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    });
  });
  return { headers, rows };
}

export function defaultTimeColumn(headers: string[]): number {
  const preferred = ['elapsed_s', 'time_s', 'timestamp_s', 'time', 'timestamp', 't', 'timestamp_ms', 'timestamp_us', 'timestamp_ns'];
  for (const name of preferred) { const index = headers.findIndex(header => header.toLowerCase() === name); if (index >= 0) { return index; } }
  return 0;
}
export function timeScale(header: string): number {
  return /(?:_|\b)ns$/i.test(header) ? 1e-9 : /(?:_|\b)us$/i.test(header) ? 1e-6 : /(?:_|\b)ms$/i.test(header) ? 1e-3 : 1;
}

/** Min/max envelopes retain spikes and null gaps while bounding Webview traffic. */
export function reducePoints(points: Curve['points'], limit = 4000): Curve['points'] {
  if (points.length <= limit) { return points; }
  const result: Curve['points'] = [];
  const bucketSize = Math.ceil(points.length / Math.max(1, Math.floor(limit / 5)));
  for (let start = 0; start < points.length; start += bucketSize) {
    const end = Math.min(points.length, start + bucketSize);
    let low = start, high = start, gap = -1;
    for (let i = start; i < end; i++) {
      const value = points[i][1];
      if (value === null) { gap = i; continue; }
      if (points[low][1] === null || value < points[low][1]!) { low = i; }
      if (points[high][1] === null || value > points[high][1]!) { high = i; }
    }
    for (const i of [...new Set([start, low, high, gap, end - 1])].filter(i => i >= 0).sort((a, b) => a - b)) { result.push(points[i]); }
  }
  return result;
}

export function csvCurves(table: CsvTable, timeColumn: number, scale: number, selected: number[], range?: [number, number]): Curve[] {
  if (range && (!range.every(Number.isFinite) || range[0] >= range[1])) { throw new Error('缩放时间范围无效。'); }
  if (!Number.isInteger(timeColumn) || timeColumn < 0 || timeColumn >= table.headers.length || !Number.isFinite(scale) || scale <= 0) {
    throw new Error('请选择有效的时间列和时间单位。');
  }
  let previous = -Infinity;
  const origin = table.rows[0][timeColumn];
  if (origin === null) { throw new Error('CSV 第一行时间不是有效数值。'); }
  const times = table.rows.map((row, index) => {
    const value = row[timeColumn];
    if (value === null || value < previous) { throw new Error(`CSV 第 ${index + 2} 行时间缺失或倒退，请选择递增的时间列。`); }
    previous = value;
    const time = (value - origin) * scale;
    if (!Number.isFinite(time)) { throw new Error('CSV 时间跨度超出支持范围。'); }
    return time;
  });
  return [...new Set(selected)].filter(index => Number.isInteger(index) && index >= 0 && index < table.headers.length && index !== timeColumn).map(index => {
    const epochColumn = table.headers.indexOf('stream_epoch');
    let points: Curve['points'] = table.rows.flatMap((row, i): Curve['points'] => {
      const point: [number, number | null] = [times[i], row[index]];
      return epochColumn >= 0 && i > 0 && row[epochColumn] !== table.rows[i - 1][epochColumn] ? [[times[i], null], point] : [point];
    });
    if (range) {
      // One point either side keeps clipped lines continuous.
      const first = points.findIndex(point => point[0] >= range[0]);
      const last = points.findIndex(point => point[0] > range[1]);
      points = points.slice(Math.max(0, first < 0 ? points.length - 1 : first - 1), last < 0 ? undefined : last + 1);
    }
    return { name: table.headers[index], points: reducePoints(points) };
  });
}
