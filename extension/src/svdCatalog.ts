import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SvdTree } from './types';

const run = promisify(execFile);
const svdBufferBytes = 128 * 1024 * 1024;

export async function inspectSvd(backendPath: string, svdPath: string): Promise<SvdTree> {
  const { stdout } = await run(backendPath, ['--inspect-svd', svdPath], {
    windowsHide: true,
    maxBuffer: svdBufferBytes,
  });
  const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '')) as Partial<SvdTree>;
  if (typeof parsed.deviceName !== 'string' || !Array.isArray(parsed.peripherals)) {
    throw new Error('SVD inspector returned an invalid peripheral catalog');
  }
  return parsed as SvdTree;
}
