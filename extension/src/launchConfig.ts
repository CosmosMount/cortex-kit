export interface ProgramCandidate {
  debugType: 'cortex-kit' | 'cortex-debug';
  name: string;
  configuredPath: string;
  configuration: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** Finds debug images without depending on an active debug session. Cortex Kit entries win over legacy Cortex-Debug entries. */
export function configuredProgramCandidates(configurations: readonly unknown[]): ProgramCandidate[] {
  const result: ProgramCandidate[] = [];
  for (const value of configurations) {
    const configuration = asRecord(value);
    if (!configuration) { continue; }
    const type = configuration.type;
    const configuredPath = type === 'cortex-kit' ? configuration.programBinary : type === 'cortex-debug' ? configuration.executable : undefined;
    if ((type !== 'cortex-kit' && type !== 'cortex-debug') || typeof configuredPath !== 'string' || !configuredPath.trim()) { continue; }
    result.push({
      debugType: type,
      name: typeof configuration.name === 'string' ? configuration.name : type,
      configuredPath,
      configuration,
    });
  }
  return result.sort((left, right) => Number(right.debugType === 'cortex-kit') - Number(left.debugType === 'cortex-kit'));
}

/** Converts common STM32 Cortex-Debug device spellings to the probe-rs family target spelling. */
export function suggestedProbeRsChip(device: unknown): string | undefined {
  if (typeof device !== 'string' || !device.trim()) { return undefined; }
  const trimmed = device.trim();
  if (/^STM32/i.test(trimmed)) { return trimmed.replace(/T(?:X|[0-9])$/i, ''); }
  return trimmed;
}

/** Maps the portable parts of a Cortex-Debug launch entry. OpenOCD-specific fields are intentionally omitted. */
export function convertCortexDebugConfiguration(sourceValue: unknown, chipOverride?: string): Record<string, unknown> | undefined {
  const source = asRecord(sourceValue);
  if (!source || source.type !== 'cortex-debug' || (source.request !== 'launch' && source.request !== 'attach')) { return undefined; }
  const executable = typeof source.executable === 'string' ? source.executable : undefined;
  const request = source.request as 'launch' | 'attach';
  const sourceName = typeof source.name === 'string' ? source.name : 'Imported Cortex-Debug';
  const chip = chipOverride?.trim() || suggestedProbeRsChip(source.device) || '';
  const speed = typeof source.swdSpeed === 'number' && Number.isFinite(source.swdSpeed) ? source.swdSpeed : 10_000;
  return {
    type: 'cortex-kit',
    request,
    name: `${sourceName} (Cortex Kit)`,
    cwd: typeof source.cwd === 'string' ? source.cwd : '${workspaceFolder}',
    chip,
    ...(executable ? { programBinary: executable } : {}),
    ...(typeof source.preLaunchTask === 'string' ? { preLaunchTask: source.preLaunchTask } : {}),
    ...(typeof source.svdFile === 'string' ? { svdFile: source.svdFile } : { svdFile: null }),
    probe: { selector: 'auto', protocol: 'swd', speedKHz: speed, connectUnderReset: false },
    flashing: { enabled: request === 'launch' && Boolean(executable), verify: true, resetAfter: true },
    acquisition: { requestedSamplesPerSecond: 5000, historySeconds: 30 },
  };
}
