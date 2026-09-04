#!/usr/bin/env node
/**
 * Publishes a new desktop version.
 *
 *   npm run release            # 0.1.0 -> 0.1.1
 *   npm run release -- minor   # 0.1.0 -> 0.2.0
 *   npm run release -- 1.0.0   # exactly that
 *
 * Bumps the version, builds the installer and copies it to the update host,
 * where every running copy of the app will find it within half an hour and
 * every closed one will find it on next launch.
 *
 * Two things here are deliberate rather than incidental:
 *
 *   - latest.yml is uploaded last. It is the manifest clients read to decide an
 *     update exists; if it arrived before the installer, every client would
 *     immediately try to download a file that is not there yet.
 *   - The version bump is committed. A published build that does not correspond
 *     to a commit is one nobody can reproduce or roll back to.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(repo, 'apps', 'desktop');
const pkgPath = path.join(desktop, 'package.json');

const HOST = process.env.CHITCHAK_RELEASE_HOST ?? 'root@194.164.23.93';
const REMOTE_DIR = process.env.CHITCHAK_RELEASE_DIR ?? '/root/ChitChak/updates';
const KEY = process.env.CHITCHAK_RELEASE_KEY ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ssh', 'id_ed25519_chitchak');

/**
 * Only npm needs a shell, and only on Windows, where it is npm.cmd rather than
 * an executable. Everything else runs without one - a shell on Windows re-parses
 * the arguments, which splits anything containing a space, so `git commit -m
 * "Release 1.0.0"` arrives as three separate pathspecs.
 */
function needsShell(command) {
  return process.platform === 'win32' && command === 'npm';
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: 'inherit', shell: needsShell(command), ...options });
}

function capture(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', shell: needsShell(command) }).trim();
}

function bump(current, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = current.split('.').map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown version bump "${how}". Use patch, minor, major or an exact version.`);
}

// A dirty tree means the build would contain changes that are not in the
// commit the tag points at.
const dirty = capture('git', ['status', '--porcelain']);
if (dirty && !process.env.CHITCHAK_RELEASE_ALLOW_DIRTY) {
  console.error('Uncommitted changes. Commit them first, or set CHITCHAK_RELEASE_ALLOW_DIRTY=1.\n');
  console.error(dirty);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = bump(pkg.version, process.argv[2] ?? 'patch');

console.log(`\nChitChak ${pkg.version} -> ${version}\n`);
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// --publish never: electron-builder's generic provider uploads over HTTP PUT,
// which needs a server that accepts writes. Copying over SSH instead means the
// update host stays a read-only directory of files.
run('npm', ['run', 'dist:win'], { cwd: desktop });

const release = path.join(desktop, 'release');
const installer = `ChitChak-Setup-${version}.exe`;
const artifacts = [installer, `${installer}.blockmap`, 'latest.yml'];

for (const name of artifacts) {
  if (!existsSync(path.join(release, name))) {
    throw new Error(`Build did not produce ${name}. Check the electron-builder output above.`);
  }
}

run('ssh', ['-i', KEY, HOST, `mkdir -p ${REMOTE_DIR}`]);
for (const name of artifacts) {
  console.log(`\nUploading ${name}…`);
  run('scp', ['-i', KEY, path.join(release, name), `${HOST}:${REMOTE_DIR}/`]);
}

run('git', ['add', 'apps/desktop/package.json', 'package-lock.json'], { cwd: repo });
run('git', ['commit', '-m', `Release ${version}`], { cwd: repo });
run('git', ['tag', `v${version}`], { cwd: repo });

console.log(`
Published ChitChak ${version}.

  Installer   https://api.chitchak.com/updates/${installer}
  Manifest    https://api.chitchak.com/updates/latest.yml

Open apps download it in the background within 30 minutes and offer a restart;
closed ones pick it up on next launch. Nothing to tell anyone.

Push the commit and tag when ready:  git push --follow-tags
`);
