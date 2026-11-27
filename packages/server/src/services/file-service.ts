import fs from 'node:fs';
import path from 'node:path';
import type {
  InstanceFileContent,
  InstanceFileEntry,
  InstanceFileListing,
  InstanceQuickFile,
} from '@serverforge/shared';

export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024; // 1 MB safeguard for inline config editing
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024; // 100 MB safeguard for mods/world uploads

export const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.ps1',
  '.dll',
  '.vbs',
  '.msi',
  '.sh',
]);

export function isBlockedExecutableFilename(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return BLOCKED_EXECUTABLE_EXTENSIONS.has(ext);
}

const BINARY_EXTENSIONS = new Set([
  '.jar',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.7z',
  '.rar',
  '.mrpack',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.dat_old',
  '.mca',
  '.mcc',
  '.ldb',
  '.sav',
  '.pak',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.ogg',
  '.mp3',
  '.wav',
  '.pdf',
  '.class',
  '.sqlite',
  '.db',
]);

const QUICK_CONFIG_CANDIDATES: Array<{ label: string; paths: string[] }> = [
  { label: 'server.properties', paths: ['server.properties'] },
  { label: 'whitelist.json', paths: ['whitelist.json'] },
  { label: 'ops.json', paths: ['ops.json'] },
  { label: 'banned-players.json', paths: ['banned-players.json'] },
  { label: 'user_jvm_args.txt', paths: ['user_jvm_args.txt'] },
  { label: 'eula.txt', paths: ['eula.txt'] },
  {
    label: 'PalWorldSettings.ini',
    paths: [
      'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini',
      'Pal/Saved/Config/LinuxServer/PalWorldSettings.ini',
      'PalWorldSettings.ini',
    ],
  },
  {
    label: 'GameUserSettings.ini',
    paths: [
      'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
      'FactoryGame/Saved/Config/WindowsServer/GameUserSettings.ini',
      'GameUserSettings.ini',
    ],
  },
  { label: 'server-settings.json', paths: ['data/server-settings.json', 'server-settings.json'] },
];

export class FileSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileSecurityError';
  }
}

export class FileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileValidationError';
  }
}

function normalizeRelativePosix(relPath: string): string {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return cleaned === '.' ? '' : cleaned;
}

function isInsideRoot(rootReal: string, candidateReal: string): boolean {
  const rel = path.relative(rootReal, candidateReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Strictly resolves `relPath` inside `rootDir`, preventing `../` traversal,
 * null-byte injection, absolute path escapes, and symlink escapes outside `rootDir`.
 */
export function resolveSandboxedPath(rootDir: string, relPath = ''): { absPath: string; relPosix: string } {
  if (relPath.includes('\0')) {
    throw new FileSecurityError('Invalid file path: null byte not allowed.');
  }

  fs.mkdirSync(rootDir, { recursive: true });
  const rootReal = fs.realpathSync(rootDir);

  const rawTrimmed = relPath.trim();
  if (rawTrimmed && (path.isAbsolute(rawTrimmed) || /^[a-zA-Z]:/.test(rawTrimmed))) {
    throw new FileSecurityError('Absolute paths are not allowed.');
  }

  const normalized = normalizeRelativePosix(rawTrimmed);
  const segments = normalized ? normalized.split('/').filter(Boolean) : [];
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new FileSecurityError('Path traversal ("..") is not allowed.');
    }
  }

  const joined = segments.length > 0 ? path.resolve(rootReal, ...segments) : rootReal;
  if (!isInsideRoot(rootReal, joined)) {
    throw new FileSecurityError('Requested path escapes the server root directory.');
  }

  // Verify symlinks: resolve either the target itself (if it exists) or its nearest existing ancestor
  if (fs.existsSync(joined)) {
    const targetReal = fs.realpathSync(joined);
    if (!isInsideRoot(rootReal, targetReal)) {
      throw new FileSecurityError('Symlink target escapes the server root directory.');
    }
  } else {
    let cursor = path.dirname(joined);
    while (cursor && !fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (cursor && fs.existsSync(cursor)) {
      const ancestorReal = fs.realpathSync(cursor);
      if (!isInsideRoot(rootReal, ancestorReal)) {
        throw new FileSecurityError('Parent symlink escapes the server root directory.');
      }
    }
  }

  const relPosix = path.relative(rootReal, joined).replace(/\\/g, '/');
  return { absPath: joined, relPosix };
}

export function isBinaryFileName(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

export function bufferLooksBinary(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 8192);
  let nonTextCount = 0;
  for (let i = 0; i < sampleLen; i++) {
    const byte = buf[i];
    if (byte === 0) return true;
    if (byte < 7 || (byte > 14 && byte < 32)) {
      nonTextCount += 1;
    }
  }
  return sampleLen > 0 && nonTextCount / sampleLen > 0.25;
}

export function sanitizeUploadFilename(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/').trim());
  if (!base || base === '.' || base === '..' || base.includes('\0')) {
    throw new FileValidationError('Invalid filename.');
  }
  return base;
}

export class FileService {
  listDirectory(rootDir: string, relPath = ''): InstanceFileListing {
    const { absPath, relPosix } = resolveSandboxedPath(rootDir, relPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
      throw new FileValidationError(`Directory not found: ${relPosix || '/'}`);
    }

    const dirents = fs.readdirSync(absPath, { withFileTypes: true });
    const entries: InstanceFileEntry[] = [];

    for (const d of dirents) {
      const childRel = relPosix ? `${relPosix}/${d.name}` : d.name;
      try {
        const resolved = resolveSandboxedPath(rootDir, childRel);
        const st = fs.statSync(resolved.absPath);
        const isDirectory = st.isDirectory();
        const editable =
          !isDirectory && !isBinaryFileName(d.name) && st.size <= MAX_EDITABLE_FILE_BYTES;
        entries.push({
          name: d.name,
          path: resolved.relPosix,
          isDirectory,
          sizeBytes: isDirectory ? 0 : st.size,
          updatedAt: st.mtime.toISOString(),
          editable,
        });
      } catch {
        // Skip broken or escaping symlinks silently in directory listings
      }
    }

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const quickFiles: InstanceQuickFile[] = [];
    for (const candidate of QUICK_CONFIG_CANDIDATES) {
      for (const candidatePath of candidate.paths) {
        try {
          const { absPath: qAbs, relPosix: qRel } = resolveSandboxedPath(rootDir, candidatePath);
          if (fs.existsSync(qAbs) && fs.statSync(qAbs).isFile()) {
            quickFiles.push({ label: candidate.label, path: qRel, exists: true });
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    const parentPath = relPosix ? path.posix.dirname(relPosix) : null;
    return {
      currentPath: relPosix,
      parentPath: parentPath === '.' ? '' : parentPath,
      entries,
      quickFiles,
    };
  }

  readTextFile(rootDir: string, relPath: string): InstanceFileContent {
    const { absPath, relPosix } = resolveSandboxedPath(rootDir, relPath);
    if (!relPosix) {
      throw new FileValidationError('Please specify a file path.');
    }
    if (!fs.existsSync(absPath)) {
      throw new FileValidationError(`File not found: ${relPosix}`);
    }
    const st = fs.statSync(absPath);
    if (!st.isFile()) {
      throw new FileValidationError('Cannot open a directory as a text file.');
    }
    if (st.size > MAX_EDITABLE_FILE_BYTES) {
      throw new FileValidationError(
        `File "${path.basename(relPosix)}" is ${(st.size / (1024 * 1024)).toFixed(2)} MB, which exceeds the 1 MB inline editor limit. Download it instead.`
      );
    }
    if (isBinaryFileName(relPosix)) {
      throw new FileValidationError(
        `File "${path.basename(relPosix)}" is a binary file and cannot be opened in the text editor. Download it instead.`
      );
    }

    const buf = fs.readFileSync(absPath);
    if (bufferLooksBinary(buf)) {
      throw new FileValidationError(
        `File "${path.basename(relPosix)}" contains binary data and cannot be safely edited as text.`
      );
    }

    return {
      path: relPosix,
      name: path.basename(relPosix),
      content: buf.toString('utf8'),
      sizeBytes: st.size,
      updatedAt: st.mtime.toISOString(),
    };
  }

  writeTextFile(rootDir: string, relPath: string, content: string): InstanceFileContent {
    const { absPath, relPosix } = resolveSandboxedPath(rootDir, relPath);
    if (!relPosix) {
      throw new FileValidationError('Please specify a file path.');
    }
    if (isBinaryFileName(relPosix)) {
      throw new FileValidationError(`Refusing to overwrite binary file "${path.basename(relPosix)}" as text.`);
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_EDITABLE_FILE_BYTES) {
      throw new FileValidationError('File content exceeds the 1 MB inline editor limit.');
    }

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    const st = fs.statSync(absPath);
    return {
      path: relPosix,
      name: path.basename(relPosix),
      content,
      sizeBytes: st.size,
      updatedAt: st.mtime.toISOString(),
    };
  }

  createDirectory(rootDir: string, relPath: string): { path: string } {
    const { absPath, relPosix } = resolveSandboxedPath(rootDir, relPath);
    if (!relPosix) {
      throw new FileValidationError('Please provide a folder name.');
    }
    fs.mkdirSync(absPath, { recursive: true });
    return { path: relPosix };
  }

  uploadFile(
    rootDir: string,
    targetDirRel: string,
    rawFilename: string,
    buffer: Buffer,
    options?: { blockExecutables?: boolean }
  ): InstanceFileEntry {
    if (buffer.length > MAX_UPLOAD_FILE_BYTES) {
      throw new FileValidationError(
        `Uploaded file exceeds the ${Math.round(MAX_UPLOAD_FILE_BYTES / (1024 * 1024))} MB upload limit.`
      );
    }
    const filename = sanitizeUploadFilename(rawFilename);
    if (options?.blockExecutables && isBlockedExecutableFilename(filename)) {
      throw new FileSecurityError(
        `Upload blocked by Host Lockdown: executable/script file "${filename}" is not allowed while Block Executable Uploads is enabled.`
      );
    }
    const dirResolved = resolveSandboxedPath(rootDir, targetDirRel);
    fs.mkdirSync(dirResolved.absPath, { recursive: true });

    const destRel = dirResolved.relPosix ? `${dirResolved.relPosix}/${filename}` : filename;
    const destResolved = resolveSandboxedPath(rootDir, destRel);
    fs.writeFileSync(destResolved.absPath, buffer);
    const st = fs.statSync(destResolved.absPath);
    return {
      name: filename,
      path: destResolved.relPosix,
      isDirectory: false,
      sizeBytes: st.size,
      updatedAt: st.mtime.toISOString(),
      editable: !isBinaryFileName(filename) && st.size <= MAX_EDITABLE_FILE_BYTES,
    };
  }

  getDownloadInfo(rootDir: string, relPath: string): { filePath: string; filename: string; sizeBytes: number } {
    const { absPath, relPosix } = resolveSandboxedPath(rootDir, relPath);
    if (!relPosix || !fs.existsSync(absPath)) {
      throw new FileValidationError(`File not found: ${relPosix || '/'}`);
    }
    const st = fs.statSync(absPath);
    if (!st.isFile()) {
      throw new FileValidationError('Only individual files can be downloaded directly.');
    }
    return {
      filePath: absPath,
      filename: path.basename(absPath),
      sizeBytes: st.size,
    };
  }

  renameEntry(rootDir: string, fromRel: string, rawNewName: string): { fromPath: string; toPath: string } {
    const src = resolveSandboxedPath(rootDir, fromRel);
    if (!src.relPosix) {
      throw new FileValidationError('Cannot rename the server root directory.');
    }
    if (!fs.existsSync(src.absPath)) {
      throw new FileValidationError(`Path not found: ${src.relPosix}`);
    }
    const cleanName = sanitizeUploadFilename(rawNewName);
    const parentPosix = path.posix.dirname(src.relPosix);
    const toRel = parentPosix && parentPosix !== '.' ? `${parentPosix}/${cleanName}` : cleanName;
    const dst = resolveSandboxedPath(rootDir, toRel);
    if (fs.existsSync(dst.absPath)) {
      throw new FileValidationError(`A file or folder named "${cleanName}" already exists.`);
    }
    fs.renameSync(src.absPath, dst.absPath);
    return { fromPath: src.relPosix, toPath: dst.relPosix };
  }

  deleteEntry(rootDir: string, relPath: string): { deletedPath: string } {
    const target = resolveSandboxedPath(rootDir, relPath);
    if (!target.relPosix) {
      throw new FileSecurityError('Refusing to delete the server root directory.');
    }
    if (!fs.existsSync(target.absPath)) {
      throw new FileValidationError(`Path not found: ${target.relPosix}`);
    }
    fs.rmSync(target.absPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    return { deletedPath: target.relPosix };
  }
}
