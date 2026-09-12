import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
  await copyFile(join(here, '..', '..', file), join(here, '..', file));
}
