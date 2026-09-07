import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
 * So: a designed logo wins, the icons are derived from it whenever they are
 * missing or out of date, and the placeholder is only drawn when there is
 * nothing else. Deriving rather than refusing matters because the generated
 * icons are not in git - only the logo is - so a fresh clone has the logo and
 * no icons, which is the normal state rather than an error.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'build');
const logo = path.join(dir, 'logo-source.png');
const ico = path.join(dir, 'icon.ico');

if (!existsSync(logo)) {
  await import('./make-icon.mjs');
} else {
  // Out of date counts as missing. Dropping a new logo in and forgetting to
  // re-run the import is the easy mistake, and its symptom - the old icon,
  // everywhere - looks like the new one simply not being picked up.
  const stale = !existsSync(ico) || statSync(logo).mtimeMs > statSync(ico).mtimeMs;

  if (stale) {
    console.log('Generating icons from the logo.');
    // Through node, which import-logo.cjs re-executes under Electron itself.
    const run = spawnSync(process.execPath, [path.join(here, 'import-logo.cjs'), logo], {
      stdio: 'inherit',
      cwd: path.join(here, '..'),
    });
    if (run.status !== 0) {
      console.error('Could not generate icons from the logo.');
      process.exit(run.status ?? 1);
    }
  } else {
    console.log('Using the designed logo.');
  }
}
