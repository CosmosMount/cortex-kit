import { LiveWatchValue, SampleBatch, ScalarKind, VariableDescriptor } from './types';

export function mergeSubscriptionIds(plotIds: string[], liveWatchIds: string[]): string[] {
  return [...new Set([...plotIds, ...liveWatchIds])];
}

export function selectBatchChannels(batch: SampleBatch, selectedIds: Iterable<string>): SampleBatch {
  const selected = new Set(selectedIds);
  const sourceIndexes = batch.channelIds
    .map((id, index) => selected.has(id) ? index : -1)
    .filter(index => index >= 0);
  const channelIds = sourceIndexes.map(index => batch.channelIds[index]);
  const values: number[] = [];
  for (let sample = 0; sample < batch.sampleCount; sample += 1) {
    for (const channel of sourceIndexes) {
      values.push(batch.values[sample * batch.channelIds.length + channel]);
    }
  }
  return { ...batch, channelIds, values };
}

export function latestLiveWatchValues(batch: SampleBatch, selectedIds: Iterable<string>): LiveWatchValue[] {
  if (!batch.sampleCount) { return []; }
  const selected = new Set(selectedIds);
  const lastSample = batch.sampleCount - 1;
  const timestampNs = batch.startTimestampNs + lastSample * batch.samplePeriodNs;
  const actualSamplesPerSecond = batch.samplePeriodNs > 0 ? 1e9 / batch.samplePeriodNs : 0;
  return batch.channelIds.flatMap((id, channel) => selected.has(id) ? [{
    id,
    value: batch.values[lastSample * batch.channelIds.length + channel],
    timestampNs,
    actualSamplesPerSecond,
    source: 'stream' as const,
  }] : []);
}

export function formatLiveWatchValue(value: number, kind: ScalarKind): string {
  if (!Number.isFinite(value)) { return String(value); }
  if (kind === 'boolean') { return value === 0 ? 'false' : 'true'; }
  if (kind === 'float32') { return Number(value.toPrecision(9)).toString(); }
  if (kind === 'float64') { return Number(value.toPrecision(15)).toString(); }
  const integer = BigInt(Math.trunc(value));
  if (kind === 'unsigned') { return `${integer} (0x${integer.toString(16).toUpperCase()})`; }
  return integer < 0n ? integer.toString() : `${integer} (0x${integer.toString(16).toUpperCase()})`;
}

export function validateLiveWatchInput(value: string, kind: ScalarKind): string | undefined {
  const source = value.trim();
  if (!source) { return 'Enter a value'; }
  if (kind === 'boolean') { return /^(true|false|0|1)$/.test(source) ? undefined : 'Enter true, false, 0, or 1'; }
  if (kind === 'float32' || kind === 'float64') {
    const parsed = Number(source);
    return Number.isFinite(parsed) ? undefined : 'Enter a finite decimal number';
  }
  try {
    if (kind === 'unsigned' && source.startsWith('-')) { return 'Unsigned variables cannot be negative'; }
    BigInt(source);
    return undefined;
  } catch {
    return 'Enter a decimal or 0x-prefixed integer';
  }
}

export function flattenLiveWatchCatalog(variables: VariableDescriptor[]): VariableDescriptor[] {
  return variables.flatMap(variable => [variable, ...flattenLiveWatchCatalog(variable.children)]);
}
