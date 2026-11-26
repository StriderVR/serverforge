#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_KINDS = new Set(['patch', 'minor', 'major']);

function computeNextVersion(currentRaw, kind) {
  const cleaned = String(currentRaw).trim().replace(/^v/i, '').split('-')[0];
  const segments = cleaned.split('.');
  if (segments.length < 3 || segments.slice(0, 3).some((s) => !/^\d+$/.test(s))) {
    throw new Error(`Unsupported current version "${currentRaw}". Expected numeric MAJOR.MINOR.PATCH.`);
  }

  let [major, minor, patch] = segments.slice(0, 3).map((s) => Number.parseInt(s, 10));

  if (kind === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (kind === 'minor') {
    minor += 1;
    patch = 0;
  } else if (kind === 'patch') {
    patch += 1;
  }

  return `${major}.${minor}.${patch}`;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const kind = args.find((a) => !a.startsWith('-'));

  if (!kind || !VALID_KINDS.has(kind)) {
    console.error('Usage: node scripts/bump-version.mjs <patch|minor|major> [--dry-run]');
    process.exit(1);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(scriptDir, '..', 'package.json');
  const rawJson = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(rawJson);

  const currentVersion = pkg.version;
  const nextVersion = computeNextVersion(currentVersion, kind);

  if (dryRun) {
    console.log(`[dry-run] ${kind}: v${currentVersion} -> v${nextVersion} (package.json unchanged)`);
    return;
  }

  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  console.log(`Updated package.json version: v${currentVersion} -> v${nextVersion}`);
  console.log('');
  console.log('Next steps to publish this release:');
  console.log(`  pnpm build && pnpm typecheck && pnpm test`);
  console.log(`  git add package.json`);
  console.log(`  git commit -m "Release v${nextVersion}"`);
  console.log(`  git tag v${nextVersion}`);
  console.log(`  git push origin main --tags`);
}

main();
