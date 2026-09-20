import { ScalarKind, VariableDescriptor } from './types';

export function mergeSubscriptionIds(plotIds: string[], liveWatchIds: string[]): string[] {
  return [...new Set([...plotIds, ...liveWatchIds])];
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

/** Shared channels use Plot samples; watch-only channels stay at the watch rate. */
export function splitSubscriptions(plotIds: string[], liveWatchIds: string[], plotRate: number, watchRate: number) {
  const ids = [...new Set(plotIds.length ? plotIds : liveWatchIds)];
  const foreground = new Set(ids);
  return {
    ids,
    requestedSamplesPerSecond: Math.max(1, plotIds.length ? plotRate : watchRate),
    backgroundIds: [...new Set(liveWatchIds)].filter(id => !foreground.has(id)),
    backgroundSamplesPerSecond: Math.max(1, Math.min(1000, watchRate)),
  };
}
