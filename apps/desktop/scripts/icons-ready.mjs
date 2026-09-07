import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Makes sure there are icons to package, without ever overwriting a real one.
 *
 * The placeholder generator used to run on every build. Once a designed logo is
 * in place that is actively wrong: a build would quietly replace it with three
 * drawn bars, and the only sign would be the wrong icon appearing in an
 * installer somebody had already shipped.
 *
 * So: a designed logo wins, and the placeholder is only drawn when there is
 * nothing else.
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const designed = path.join(dir, 'logo-source.png');

if (existsSync(designed)) {
  if (!existsSync(path.join(dir, 'icon.ico'))) {
    console.error('A logo is present but the icons have not been generated from it.');
    console.error('Run:  npm run logo -w @chitchak/desktop');
    process.exit(1);
  }
  console.log('Using the designed logo.');
} else {
  await import('./make-icon.mjs');
}
