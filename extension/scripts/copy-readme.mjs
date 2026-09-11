import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await copyFile(join(here, '..', '..', 'README.md'), join(here, '..', 'README.md'));
