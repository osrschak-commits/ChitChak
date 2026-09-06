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
 * It builds for the machine it runs on, because neither platform can build the
 * other: electron-builder needs macOS to make a .dmg, and the Windows toolchain
 * only exists on Windows. So a release that covers both is two runs, and the
 * second one must not bump the version again:
 *
 *   Windows:  npm run release              # bumps, builds .exe, commits, tags
 *   Mac:      npm run release -- --no-bump # builds .dmg/.zip for that version
 *
 * Whichever order suits. The manifests do not collide - Windows clients read
 * latest.yml and Mac clients read latest-mac.yml - so a version that only ever
 * gets a Windows build is a perfectly valid state, it just means Mac users stay
 * where they are.
 *
 * Three things here are deliberate rather than incidental:
 *
 *   - The manifest is uploaded last. It is what clients read to decide an
 *     update exists; if it arrived before the installer, every client would
 *     immediately try to download a file that is not there yet.
 *   - The version bump is committed. A published build that does not correspond
 *     to a commit is one nobody can reproduce or roll back to.
 *   - --no-bump does not commit or tag either. The commit belongs to the run
 *     that decided the version; a second one would be an empty commit claiming
 *     to be a release.
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

const args = process.argv.slice(2);
const shouldBump = !args.includes('--no-bump');
const how = args.find((arg) => !arg.startsWith('--')) ?? 'patch';

/**
 * Which platform's artifacts this run produces. Only the host's are buildable,
 * so this is a fact about the machine rather than a choice.
 */
const target = process.platform === 'darwin' ? 'mac' : 'win';
if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.error(`Cannot build a desktop release on ${process.platform}. Use Windows or macOS.`);
  process.exit(1);
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
const version = shouldBump ? bump(pkg.version, how) : pkg.version;

if (shouldBump) {
  console.log(`\nChitChak ${pkg.version} -> ${version} (${target})\n`);
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
} else {
  console.log(`\nChitChak ${version} (${target}, no version change)\n`);
}

// --publish never: electron-builder's generic provider uploads over HTTP PUT,
// which needs a server that accepts writes. Copying over SSH instead means the
// update host stays a read-only directory of files.
run('npm', ['run', `dist:${target}`], { cwd: desktop });

const release = path.join(desktop, 'release');

/**
 * What to upload, manifest last.
 *
 * macOS gets six files rather than three because it is built twice, once per
 * architecture. The .zip is not a convenience copy of the .dmg - it is what
 * electron-updater downloads - and the blockmaps are what make an update fetch
 * only the changed parts of it.
 */
const artifacts =
  target === 'win'
    ? [`ChitChak-Setup-${version}.exe`, `ChitChak-Setup-${version}.exe.blockmap`, 'latest.yml']
    : [
        ...['arm64', 'x64'].flatMap((arch) => [
          `ChitChak-${version}-${arch}.dmg`,
          `ChitChak-${version}-${arch}.zip`,
          `ChitChak-${version}-${arch}.zip.blockmap`,
        ]),
        'latest-mac.yml',
      ];

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

if (shouldBump) {
  run('git', ['add', 'apps/desktop/package.json', 'package-lock.json'], { cwd: repo });
  run('git', ['commit', '-m', `Release ${version}`], { cwd: repo });
  run('git', ['tag', `v${version}`], { cwd: repo });
}

const base = 'https://api.chitchak.com/updates';
const downloads = artifacts
  .filter((name) => name.endsWith('.exe') || name.endsWith('.dmg'))
  .map((name) => `  ${base}/${name}`)
  .join('\n');

console.log(`
Published ChitChak ${version} for ${target === 'win' ? 'Windows' : 'macOS'}.

${downloads}
  ${base}/${target === 'win' ? 'latest.yml' : 'latest-mac.yml'}
`);

console.log(
  target === 'win'
    ? `Open apps download it in the background within 30 minutes and offer a restart;
closed ones pick it up on next launch. Nothing to tell anyone.
`
    : `Mac apps cannot install this themselves - the build is unsigned, and
Squirrel.Mac will not swap in a bundle it cannot verify. Open apps show
"Update available · Download" within 30 minutes, which opens the .dmg for
their architecture. Tell people to drag it over the old one.
`,
);

if (shouldBump) {
  console.log('Push the commit and tag when ready:  git push --follow-tags\n');
  if (target === 'win') {
    console.log('Then, on a Mac:  git pull && npm run release -- --no-bump\n');
  }
}
