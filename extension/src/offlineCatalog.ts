import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { VariableDescriptor } from './types';

const run = promisify(execFile);
const catalogBufferBytes = 128 * 1024 * 1024;

export function isDwarfImage(filePath: string): boolean {
  return ['.elf', '.axf', '.out'].includes(path.extname(filePath).toLowerCase());
}

export function resolveConfiguredPath(configuredPath: string, workspaceFolder: string, environment: NodeJS.ProcessEnv = process.env): string {
  let resolved = configuredPath.replace(/\$\{workspaceFolder\}/g, workspaceFolder);
  resolved = resolved.replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => environment[name] ?? _match);
  return path.normalize(path.isAbsolute(resolved) ? resolved : path.resolve(workspaceFolder, resolved));
}

export async function inspectElf(backendPath: string, elfPath: string): Promise<VariableDescriptor[]> {
  const { stdout } = await run(backendPath, ['--inspect-elf', elfPath], {
    windowsHide: true,
    maxBuffer: catalogBufferBytes,
  });
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(parsed)) { throw new Error('ELF inspector returned a non-array variable catalog'); }
  return parsed as VariableDescriptor[];
}
