import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'webview-ui');
const destination = join(here, '..', 'media');
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
