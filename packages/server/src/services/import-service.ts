import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DetectedServerSubfolder,
  DiscoveredProcess,
  FolderBrowseEntry,
  FolderBrowseResult,
  FolderPickResult,
  ImportInspectionResult,
  ImportLaunchCandidate,
} from '@serverforge/shared';

export function parsePropertiesFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/\\:/g, ':');
    result[key] = val;
  }
  return result;
}

/**
 * Safely updates ONLY RCON keys inside an existing server.properties file,
 * preserving every custom modded setting and comment line untouched.
 */
export function enableRconInServerProperties(
  serverDir: string,
  rconPort: number,
  rconPassword: string
): void {
  const propsPath = path.join(serverDir, 'server.properties');
  const existing = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const updates: Record<string, string> = {
    'enable-rcon': 'true',
    'rcon.port': String(rconPort),
    'rcon.password': rconPassword,
  };
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx).trim();
    if (key in updates) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) {
      out.push(`${k}=${v}`);
    }
  }

  fs.writeFileSync(propsPath, out.join('\n').replace(/\n+$/, '\n'), 'utf8');
}

export function parseXmxMemoryMb(text: string): number | null {
  // Matches -Xmx10G, -Xmx8192M, MAX_RAM=12G, etc.
  const xmxMatch = text.match(/-Xmx(\d+)\s*([GMK])/i) ?? text.match(/MAX_RAM\s*=\s*"?(\d+)\s*([GM])"?/i);
  if (!xmxMatch) return null;
  const amount = Number.parseInt(xmxMatch[1], 10);
  const unit = xmxMatch[2].toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (unit === 'G') return amount * 1024;
  if (unit === 'M') return amount;
  if (unit === 'K') return Math.max(512, Math.round(amount / 1024));
  return null;
}

const SCRIPT_PRIORITY = [
  'startserver.bat',
  'serverstart.bat',
  'start.bat',
  'run.bat',
  'launch.bat',
  'startserver.ps1',
  'serverstart.ps1',
  'start.ps1',
  'run.ps1',
  'launch.ps1',
  'startserver.sh',
  'serverstart.sh',
  'start.sh',
  'run.sh',
  'launch.sh',
];

const GENERIC_PACK_SUBFOLDER_RE =
  /^(server[-_ .]?files.*|server[-_ .]?pack.*|simple[-_ .]?server[-_ .]?files.*|server|minecraft[-_ .]?server.*|pack)$/i;

const SKIP_SCAN_DIRS = new Set([
  'mods',
  'libraries',
  'config',
  'defaultconfigs',
  'kubejs',
  'world',
  'world_nether',
  'world_the_end',
  'logs',
  'crash-reports',
  'backups',
  'saves',
  'cache',
  'versions',
  'plugins',
  'datapacks',
  'resourcepacks',
  'shaderpacks',
  'node_modules',
  '.git',
  '.fabric',
  '.mixin.out',
  '__macosx',
  '$recycle.bin',
  'system volume information',
]);

export interface RawDiscoveredProcess {
  pid: number;
  parentPid?: number | null;
  processName: string;
  executablePath?: string | null;
  commandLine?: string | null;
  processCwd?: string | null;
  ancestorCommandLines?: string[];
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Pure C# 5 helper compiled via PowerShell Add-Type to read any accessible
 * Windows process's Current Working Directory directly from its PEB
 * (supports both 64-bit native processes and 32-bit WoW64 processes).
 */
export const WINDOWS_PEB_CWD_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SfProcCwd {
    private const uint PROCESS_QUERY_INFORMATION = 0x0400;
    private const uint PROCESS_VM_READ = 0x0010;
    private const int ProcessBasicInformation = 0;
    private const int ProcessWow64Information = 26;

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(
        IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle, int processInformationClass,
        ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle, int processInformationClass,
        ref IntPtr processInformation, int processInformationLength, out int returnLength);

    public static string GetWorkingDirectory(int pid) {
        IntPtr hProc = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (hProc == IntPtr.Zero) return null;
        try {
            IntPtr wow64Peb = IntPtr.Zero;
            int retLen;
            int wowStatus = NtQueryInformationProcess(hProc, ProcessWow64Information, ref wow64Peb, IntPtr.Size, out retLen);
            if (wowStatus == 0 && wow64Peb != IntPtr.Zero) {
                return ReadCwd32(hProc, wow64Peb);
            }
            return ReadCwd64(hProc);
        } catch {
            return null;
        } finally {
            CloseHandle(hProc);
        }
    }

    private static string ReadCwd64(IntPtr hProc) {
        PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
        int retLen;
        if (NtQueryInformationProcess(hProc, ProcessBasicInformation, ref pbi, Marshal.SizeOf(pbi), out retLen) != 0)
            return null;
        if (pbi.PebBaseAddress == IntPtr.Zero) return null;

        byte[] ptrBuf = new byte[8];
        IntPtr bytesRead;
        if (!ReadProcessMemory(hProc, IntPtr.Add(pbi.PebBaseAddress, 0x20), ptrBuf, 8, out bytesRead))
            return null;
        IntPtr procParams = new IntPtr(BitConverter.ToInt64(ptrBuf, 0));
        if (procParams == IntPtr.Zero) return null;

        byte[] usBuf = new byte[16];
        if (!ReadProcessMemory(hProc, IntPtr.Add(procParams, 0x38), usBuf, 16, out bytesRead))
            return null;
        ushort len = BitConverter.ToUInt16(usBuf, 0);
        IntPtr strPtr = new IntPtr(BitConverter.ToInt64(usBuf, 8));
        if (len == 0 || len > 32768 || strPtr == IntPtr.Zero) return null;

        byte[] strBuf = new byte[len];
        if (!ReadProcessMemory(hProc, strPtr, strBuf, len, out bytesRead))
            return null;
        return Encoding.Unicode.GetString(strBuf, 0, Math.Min((int)len, bytesRead.ToInt32()));
    }

    private static string ReadCwd32(IntPtr hProc, IntPtr peb32) {
        byte[] ptrBuf = new byte[4];
        IntPtr bytesRead;
        if (!ReadProcessMemory(hProc, IntPtr.Add(peb32, 0x10), ptrBuf, 4, out bytesRead))
            return null;
        uint procParams = BitConverter.ToUInt32(ptrBuf, 0);
        if (procParams == 0) return null;

        byte[] usBuf = new byte[8];
        if (!ReadProcessMemory(hProc, new IntPtr((long)procParams + 0x24), usBuf, 8, out bytesRead))
            return null;
        ushort len = BitConverter.ToUInt16(usBuf, 0);
        uint strPtr = BitConverter.ToUInt32(usBuf, 4);
        if (len == 0 || len > 32768 || strPtr == 0) return null;

        byte[] strBuf = new byte[len];
        if (!ReadProcessMemory(hProc, new IntPtr((long)strPtr), strBuf, len, out bytesRead))
            return null;
        return Encoding.Unicode.GetString(strBuf, 0, Math.Min((int)len, bytesRead.ToInt32()));
    }
}
`;

export function buildWindowsPebCwdProbeScript(pid: number): string {
  return `
if (-not ('SfProcCwd' -as [type])) {
  Add-Type -TypeDefinition @'
${WINDOWS_PEB_CWD_CSHARP}
'@ -Language CSharp -ErrorAction Stop
}
$cwd = [SfProcCwd]::GetWorkingDirectory(${Math.trunc(pid)})
[PSCustomObject]@{ cwd = $cwd } | ConvertTo-Json -Compress
`;
}

/**
 * Pure C# 5 COM interop for the modern Windows 10/11 File Explorer
 * "Select Folder" dialog (IFileOpenDialog + FOS_PICKFOLDERS).
 */
export const WINDOWS_FOLDER_PICKER_CSHARP = `
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class SfFolderPicker {
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW {}

    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    public static string PickFolder(string initialDir, string title, bool dryRun) {
        IFileDialog dialog = (IFileDialog)new FileOpenDialogRCW();
        IShellItem initialItem = null;
        IShellItem resultItem = null;
        try {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            if (!string.IsNullOrEmpty(title)) {
                dialog.SetTitle(title);
            }
            if (!string.IsNullOrEmpty(initialDir) && Directory.Exists(initialDir)) {
                Guid shellItemGuid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
                if (SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref shellItemGuid, out initialItem) == 0 && initialItem != null) {
                    dialog.SetFolder(initialItem);
                }
            }
            if (dryRun) {
                return "__DRY_RUN_OK__";
            }

            int hr;
            using (Form owner = new Form()) {
                owner.TopMost = true;
                owner.StartPosition = FormStartPosition.CenterScreen;
                owner.FormBorderStyle = FormBorderStyle.None;
                owner.Size = new Size(0, 0);
                owner.ShowInTaskbar = false;
                owner.Opacity = 0;
                owner.Show();
                owner.Activate();
                hr = dialog.Show(owner.Handle);
                owner.Close();
            }

            if (hr == ERROR_CANCELLED) {
                return null;
            }
            if (hr != 0) {
                Marshal.ThrowExceptionForHR(hr);
            }
            dialog.GetResult(out resultItem);
            if (resultItem == null) return null;
            string selectedPath;
            resultItem.GetDisplayName(SIGDN_FILESYSPATH, out selectedPath);
            return selectedPath;
        } finally {
            if (resultItem != null) Marshal.ReleaseComObject(resultItem);
            if (initialItem != null) Marshal.ReleaseComObject(initialItem);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
        }
    }
}
`;

export function buildWindowsFolderPickerScript(initialDir?: string, dryRun = false): string {
  const escapedInitial = (initialDir || '').replace(/'/g, "''");
  const dryFlag = dryRun ? '$true' : '$false';
  return `
$ErrorActionPreference = 'Stop'
if (-not ${dryFlag} -and -not [Environment]::UserInteractive) {
  [PSCustomObject]@{ supported = $false; cancelled = $false; folderPath = $null; reason = 'ServerForge is running in a non-interactive Windows session. Use the Web Browser button instead.' } | ConvertTo-Json -Compress
  exit 0
}
try {
  if (-not ('SfFolderPicker' -as [type])) {
    Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') -TypeDefinition @'
${WINDOWS_FOLDER_PICKER_CSHARP}
'@ -Language CSharp -ErrorAction Stop
  }
  $selected = [SfFolderPicker]::PickFolder('${escapedInitial}', 'Select Game Server Folder', ${dryFlag})
  if ([string]::IsNullOrWhiteSpace($selected)) {
    [PSCustomObject]@{ supported = $true; cancelled = $true; folderPath = $null } | ConvertTo-Json -Compress
  } else {
    [PSCustomObject]@{ supported = $true; cancelled = $false; folderPath = $selected } | ConvertTo-Json -Compress
  }
} catch {
  [PSCustomObject]@{ supported = $false; cancelled = $false; folderPath = $null; reason = $_.Exception.Message } | ConvertTo-Json -Compress
}
`;
}

/**
 * Normalizes a Windows/POSIX directory path to the actual game server root
 * (stripping trailing slashes, rejecting System32, and stripping known nested
 * game binary folders like ShooterGame\Binaries\Win64 or Pal\Binaries\Win64).
 */
export function normalizeServerRootDir(rawDir: string | null | undefined, processName?: string): string | null {
  if (!rawDir) return null;
  let cleaned = rawDir.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) return null;

  const isWinPath = /^[A-Za-z]:[\\/]/.test(cleaned) || cleaned.startsWith('\\\\');
  if (isWinPath) {
    cleaned = cleaned.replace(/\//g, '\\');
    // Strip trailing slashes except drive root like C:\
    if (cleaned.length > 3) {
      cleaned = cleaned.replace(/\\+$/, '');
    }
    // Reject generic Windows system folders (often inherited by elevated or service launchers)
    if (/^[A-Za-z]:\\Windows(\\System32|\\SysWOW64)?$/i.test(cleaned)) {
      return null;
    }

    const nestedBinaries = [
      /\\ShooterGame\\Binaries\\Win64$/i,
      /\\Pal\\Binaries\\Win64$/i,
      /\\FactoryGame\\Binaries\\Win64$/i,
    ];
    for (const re of nestedBinaries) {
      if (re.test(cleaned)) {
        cleaned = cleaned.replace(re, '');
        break;
      }
    }
    if ((processName || '').toLowerCase().includes('factorio') && /\\bin\\x64$/i.test(cleaned)) {
      cleaned = cleaned.replace(/\\bin\\x64$/i, '');
    }
  } else {
    if (cleaned.length > 1) {
      cleaned = cleaned.replace(/\/+$/, '');
    }
    const nestedBinaries = [
      /\/ShooterGame\/Binaries\/Win64$/i,
      /\/Pal\/Binaries\/Win64$/i,
      /\/FactoryGame\/Binaries\/Win64$/i,
    ];
    for (const re of nestedBinaries) {
      if (re.test(cleaned)) {
        cleaned = cleaned.replace(re, '');
        break;
      }
    }
    if ((processName || '').toLowerCase().includes('factorio') && /\/bin\/x64$/i.test(cleaned)) {
      cleaned = cleaned.replace(/\/bin\/x64$/i, '');
    }
  }

  return cleaned || null;
}

/**
 * Extracts a server folder path from a process CommandLine when OS CWD wasn't available.
 * Supports -Duser.dir=..., quoted paths with spaces, @argfiles, \libraries\, and .jar paths.
 */
export function extractWorkingDirFromCommandLine(cmd: string): string | null {
  if (!cmd) return null;

  // 1. Explicit -Duser.dir="C:\..." or -Duser.dir=C:\...
  const userDirMatch =
    cmd.match(/-Duser\.dir="([A-Za-z]:\\[^"]+)"/i) ?? cmd.match(/-Duser\.dir=([A-Za-z]:\\[^\s"]+)/i);
  if (userDirMatch) {
    return normalizeServerRootDir(userDirMatch[1]);
  }

  // 2. Quoted or unquoted absolute Windows path referencing server artifacts (supports spaces inside quotes)
  const patterns = [
    /@?"([A-Za-z]:\\[^"]+?(?:\\libraries\\[^"]+|\\user_jvm_args\.txt|\\win_args\.txt|\.jar))"/i,
    /@?([A-Za-z]:\\[^\s"]+?(?:\\libraries\\[^\s"]+|\\user_jvm_args\.txt|\\win_args\.txt|\.jar))/i,
  ];

  for (const re of patterns) {
    const match = cmd.match(re);
    if (!match) continue;
    const matched = match[1];
    // Ignore JDK/JRE installation binaries
    if (/\\(Program Files|Program Files \(x86\))\\(Java|Eclipse Adoptium|AdoptOpenJDK|Zulu|Microsoft\\jdk)/i.test(matched)) {
      continue;
    }
    const libIdx = matched.toLowerCase().indexOf('\\libraries');
    const dir = libIdx > 0 ? matched.slice(0, libIdx) : path.win32.dirname(matched);
    const normalized = normalizeServerRootDir(dir);
    if (normalized) return normalized;
  }

  return null;
}

/**
 * Extracts a server folder from parent/grandparent launcher commands such as:
 *   cmd.exe /c ""C:\Users\penhe\Desktop\Minecraft Servers\ATM 10\startserver.bat""
 *   powershell.exe -File "D:\Servers\ATM10\startserver.ps1"
 */
export function extractWorkingDirFromAncestorCommands(ancestorCommands: string[]): string | null {
  for (const rawCmd of ancestorCommands) {
    if (!rawCmd) continue;
    const patterns = [
      /"([A-Za-z]:\\[^"]+?\.(?:bat|cmd|ps1))"/gi,
      /([A-Za-z]:\\[^\s"]+?\.(?:bat|cmd|ps1))/gi,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(rawCmd)) !== null) {
        const scriptFile = m[1];
        if (/^[A-Za-z]:\\Windows\\/i.test(scriptFile)) continue;
        const dir = normalizeServerRootDir(path.win32.dirname(scriptFile));
        if (dir) return dir;
      }
    }
  }
  return null;
}

/**
 * Parses `user.dir=...` from `jcmd <pid> VM.system_properties` output,
 * unescaping Java .properties escaping (`\:` -> `:`, `\\` -> `\`).
 */
export function parseJavaUserDirFromProperties(output: string): string | null {
  if (!output) return null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('user.dir=')) continue;
    const rawVal = line.slice('user.dir='.length).trim();
    const unescaped = rawVal.replace(/\\:/g, ':').replace(/\\\\/g, '\\');
    return normalizeServerRootDir(unescaped);
  }
  return null;
}

/**
 * Resolves workingDir across all available signals and deduplicates parent/child
 * launcher wrapper pairs (e.g. Oracle javapath java.exe -> JDK java.exe,
 * PalServer.exe -> PalServer-Win64-Shipping-Cmd.exe).
 */
export function normalizeDiscoveredProcesses(rawList: RawDiscoveredProcess[]): DiscoveredProcess[] {
  const enriched = rawList.map((item) => {
    const cmd = item.commandLine || '';
    const nameLower = (item.processName || '').toLowerCase();
    let detectedGameId = 'minecraft-curseforge';
    if (nameLower.includes('ark')) detectedGameId = 'ark-survival-ascended';
    else if (nameLower.includes('palserver')) detectedGameId = 'palworld';
    else if (nameLower.includes('factory')) detectedGameId = 'satisfactory';
    else if (nameLower.includes('factorio')) detectedGameId = 'factorio';

    const isJava = nameLower.includes('java');
    let workingDir: string | null = null;

    // 1. Direct OS process CWD (from Win32 PEB)
    workingDir = normalizeServerRootDir(item.processCwd, item.processName);

    // 2. Non-Java executablePath (with nested binary folder normalization)
    if (!workingDir && !isJava && item.executablePath) {
      const dir = /^[A-Za-z]:[\\/]/.test(item.executablePath)
        ? path.win32.dirname(item.executablePath)
        : path.dirname(item.executablePath);
      workingDir = normalizeServerRootDir(dir, item.processName);
    }

    // 3. CommandLine absolute path extraction (supports spaces & -Duser.dir)
    if (!workingDir) {
      workingDir = extractWorkingDirFromCommandLine(cmd);
    }

    // 4. Ancestor cmd.exe / powershell.exe launcher script directory
    if (!workingDir && item.ancestorCommandLines && item.ancestorCommandLines.length > 0) {
      workingDir = extractWorkingDirFromAncestorCommands(item.ancestorCommandLines);
    }

    return {
      pid: item.pid,
      parentPid: item.parentPid ?? null,
      processName: item.processName,
      executablePath: item.executablePath ?? null,
      detectedGameId,
      workingDir,
      commandLine: cmd.slice(0, 320),
    };
  });

  // Identify wrapper/shim processes that are ancestors of another detected server process
  const byPid = new Map(enriched.map((p) => [p.pid, p]));
  const wrapperPids = new Set<number>();

  for (const proc of enriched) {
    let cursor = proc.parentPid;
    const visited = new Set<number>([proc.pid]);
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const parent = byPid.get(cursor);
      if (!parent) break;
      wrapperPids.add(parent.pid);
      cursor = parent.parentPid;
    }
  }

  // Keep leaf server processes; inherit workingDir from collapsed parent wrapper if needed
  const results: DiscoveredProcess[] = [];
  for (const proc of enriched) {
    if (wrapperPids.has(proc.pid)) continue;
    let resolvedDir = proc.workingDir;
    if (!resolvedDir) {
      let cursor = proc.parentPid;
      const visited = new Set<number>([proc.pid]);
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const parent = byPid.get(cursor);
        if (!parent) break;
        if (parent.workingDir) {
          resolvedDir = parent.workingDir;
          break;
        }
        cursor = parent.parentPid;
      }
    }
    results.push({
      pid: proc.pid,
      processName: proc.processName,
      detectedGameId: proc.detectedGameId,
      workingDir: resolvedDir,
      commandLine: proc.commandLine,
    });
  }

  return results;
}

interface ServerFolderProbe {
  isServerFolder: boolean;
  hint: string | null;
  summary: string;
}

function probeServerFolder(dirPath: string): ServerFolderProbe {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const namesLower = new Map(entries.map((e) => [e.name.toLowerCase(), e]));

    if (fs.existsSync(path.join(dirPath, 'ShooterGame', 'Binaries', 'Win64', 'ArkAscendedServer.exe'))) {
      return { isServerFolder: true, hint: 'Ark ASA', summary: 'Ark: Survival Ascended' };
    }
    if (namesLower.has('palserver.exe') || namesLower.has('palserver.sh')) {
      return { isServerFolder: true, hint: 'Palworld', summary: 'Palworld Dedicated Server' };
    }
    if (namesLower.has('factoryserver.exe') || namesLower.has('factoryserver.sh')) {
      return { isServerFolder: true, hint: 'Satisfactory', summary: 'Satisfactory Dedicated Server' };
    }
    if (
      fs.existsSync(path.join(dirPath, 'bin', 'x64', 'factorio.exe')) ||
      fs.existsSync(path.join(dirPath, 'bin', 'x64', 'factorio'))
    ) {
      return { isServerFolder: true, hint: 'Factorio', summary: 'Factorio Dedicated Server' };
    }

    const hasServerProps = namesLower.has('server.properties');
    const hasJvmArgs = namesLower.has('user_jvm_args.txt');
    const hasNeoForge = fs.existsSync(path.join(dirPath, 'libraries', 'net', 'neoforged'));
    const hasForge =
      fs.existsSync(path.join(dirPath, 'libraries', 'net', 'minecraftforge')) ||
      entries.some((e) => e.isFile() && /forge.*\.jar$/i.test(e.name));
    const hasFabric =
      fs.existsSync(path.join(dirPath, '.fabric')) ||
      entries.some((e) => e.isFile() && /fabric.*\.jar$/i.test(e.name));
    const hasPaper = entries.some((e) => e.isFile() && /(paper|purpur|spigot).*\.jar$/i.test(e.name));

    let modCount = 0;
    const modsEntry = namesLower.get('mods');
    if (modsEntry?.isDirectory()) {
      try {
        modCount = fs
          .readdirSync(path.join(dirPath, modsEntry.name))
          .filter((f) => f.toLowerCase().endsWith('.jar')).length;
      } catch {
        // ignore unreadable mods dir
      }
    }

    const firstScript = SCRIPT_PRIORITY.map((s) => namesLower.get(s)?.name).find(Boolean) ?? null;

    let hasWorld = false;
    for (const e of entries) {
      if (e.isDirectory() && fs.existsSync(path.join(dirPath, e.name, 'level.dat'))) {
        hasWorld = true;
        break;
      }
    }

    const strongMarker = Boolean(
      hasServerProps ||
        hasJvmArgs ||
        hasNeoForge ||
        hasForge ||
        hasFabric ||
        hasPaper ||
        modCount > 0 ||
        hasWorld ||
        (firstScript && (namesLower.has('eula.txt') || namesLower.has('config') || entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar'))))
    );

    if (!strongMarker) {
      return { isServerFolder: false, hint: null, summary: '' };
    }

    const loader = hasNeoForge
      ? 'NeoForge'
      : hasForge
        ? 'Forge'
        : hasFabric
          ? 'Fabric'
          : hasPaper
            ? 'Paper / Spigot'
            : modCount > 0
              ? 'Modded MC'
              : 'Minecraft';

    const parts = [loader];
    if (modCount > 0) parts.push(`${modCount} mods`);
    if (firstScript) parts.push(firstScript);
    else if (hasServerProps) parts.push('server.properties');

    return {
      isServerFolder: true,
      hint: loader,
      summary: parts.join(' • '),
    };
  } catch {
    return { isServerFolder: false, hint: null, summary: '' };
  }
}

function findNestedServerDirs(rootDir: string, maxDepth = 3): DetectedServerSubfolder[] {
  const found: DetectedServerSubfolder[] = [];

  const walk = (currentDir: string, depth: number) => {
    if (depth > maxDepth || found.length >= 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lower = entry.name.toLowerCase();
      if (SKIP_SCAN_DIRS.has(lower) || lower.startsWith('.')) continue;

      const childPath = path.join(currentDir, entry.name);
      const probe = probeServerFolder(childPath);
      if (probe.isServerFolder) {
        found.push({
          name: entry.name,
          relativePath: path.relative(rootDir, childPath),
          path: childPath,
          summary: probe.summary,
        });
        // Do not recurse inside an already-detected server root (its subdirs are worlds/mods/etc.)
        continue;
      }

      if (depth < maxDepth) {
        walk(childPath, depth + 1);
      }
    }
  };

  walk(rootDir, 1);
  found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return found;
}

export class SmartImportService {
  private activeFolderPick: Promise<FolderPickResult> | null = null;

  inspectDirectory(rawPath: string, allowNestedAutoResolve = true): ImportInspectionResult {
    const folderPath = path.resolve(rawPath.trim().replace(/^["']|["']$/g, ''));
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder does not exist: ${folderPath}`);
    }
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${folderPath}`);
    }

    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const entryNamesLower = new Map(entries.map((e) => [e.name.toLowerCase(), e.name]));
    const warnings: string[] = [];

    // 1. Detect non-Minecraft games first if their exact binaries exist
    if (fs.existsSync(path.join(folderPath, 'ShooterGame', 'Binaries', 'Win64', 'ArkAscendedServer.exe'))) {
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Ark ASA Server',
        detectedGameId: 'ark-survival-ascended',
        detectedGameName: 'Ark: Survival Ascended',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'ShooterGame', 'Saved')) ? ['ShooterGame/Saved'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [
          {
            label: 'ArkAscendedServer.exe (Native Binary)',
            script: 'ShooterGame/Binaries/Win64/ArkAscendedServer.exe',
            recommended: true,
          },
        ],
        detectedPorts: { game: 7777, peer: 7778, rcon: 27020 },
        detectedMemoryMb: 16384,
        detectedConfig: {},
        warnings,
      };
    }

    if (entryNamesLower.has('palserver.exe') || entryNamesLower.has('palserver.sh')) {
      const bin = entryNamesLower.get('palserver.exe') ?? entryNamesLower.get('palserver.sh')!;
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Palworld Server',
        detectedGameId: 'palworld',
        detectedGameName: 'Palworld',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'Pal', 'Saved')) ? ['Pal/Saved'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [{ label: bin, script: bin, recommended: true }],
        detectedPorts: { game: 8211, query: 27015, rest: 8212, rcon: 25575 },
        detectedMemoryMb: 16384,
        detectedConfig: {},
        warnings,
      };
    }

    if (entryNamesLower.has('factoryserver.exe') || entryNamesLower.has('factoryserver.sh')) {
      const bin = entryNamesLower.get('factoryserver.exe') ?? entryNamesLower.get('factoryserver.sh')!;
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Satisfactory Server',
        detectedGameId: 'satisfactory',
        detectedGameName: 'Satisfactory',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'FactoryGame', 'Saved')) ? ['FactoryGame/Saved'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [{ label: bin, script: bin, recommended: true }],
        detectedPorts: { game: 7777 },
        detectedMemoryMb: 12288,
        detectedConfig: {},
        warnings,
      };
    }

    if (
      fs.existsSync(path.join(folderPath, 'bin', 'x64', 'factorio.exe')) ||
      fs.existsSync(path.join(folderPath, 'bin', 'x64', 'factorio'))
    ) {
      const bin = fs.existsSync(path.join(folderPath, 'bin', 'x64', 'factorio.exe'))
        ? 'bin/x64/factorio.exe'
        : 'bin/x64/factorio';
      return {
        folderPath,
        suggestedName: path.basename(folderPath) || 'Factorio Server',
        detectedGameId: 'factorio',
        detectedGameName: 'Factorio',
        modloader: null,
        modCount: 0,
        worldFolders: fs.existsSync(path.join(folderPath, 'saves')) ? ['saves'] : [],
        hasServerProperties: false,
        rconCurrentlyEnabled: false,
        launchCandidates: [{ label: bin, script: bin, recommended: true }],
        detectedPorts: { game: 34197, rcon: 27015 },
        detectedMemoryMb: 4096,
        detectedConfig: {},
        warnings,
      };
    }

    // 2. Inspect Minecraft (Vanilla / Paper / Modded Forge / NeoForge / Fabric / CurseForge)
    const propsPath = path.join(folderPath, 'server.properties');
    const hasServerProperties = fs.existsSync(propsPath);
    const props = hasServerProperties ? parsePropertiesFile(fs.readFileSync(propsPath, 'utf8')) : {};

    // Count installed mods
    const modsDir = path.join(folderPath, 'mods');
    let modCount = 0;
    if (fs.existsSync(modsDir) && fs.statSync(modsDir).isDirectory()) {
      modCount = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar')).length;
    }

    // Detect modloader
    let modloader: string | null = null;
    if (fs.existsSync(path.join(folderPath, 'libraries', 'net', 'neoforged'))) {
      modloader = 'NeoForge';
    } else if (
      fs.existsSync(path.join(folderPath, 'libraries', 'net', 'minecraftforge')) ||
      entries.some((e) => /forge.*\.jar$/i.test(e.name))
    ) {
      modloader = 'Forge';
    } else if (
      entries.some((e) => /fabric.*\.jar$/i.test(e.name)) ||
      fs.existsSync(path.join(folderPath, '.fabric'))
    ) {
      modloader = 'Fabric';
    } else if (entries.some((e) => /(paper|purpur|spigot).*\.jar$/i.test(e.name))) {
      modloader = 'Paper / Spigot';
    } else if (modCount > 0) {
      modloader = 'Modded';
    }

    const isModdedMc = Boolean(
      modCount > 0 ||
        modloader === 'NeoForge' ||
        modloader === 'Forge' ||
        modloader === 'Fabric' ||
        entryNamesLower.has('user_jvm_args.txt') ||
        entryNamesLower.has('manifest.json')
    );

    // Detect world folders (folders containing level.dat)
    const worldFolders: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() && fs.existsSync(path.join(folderPath, e.name, 'level.dat'))) {
        worldFolders.push(e.name);
      }
    }
    if (worldFolders.length === 0 && props['level-name'] && fs.existsSync(path.join(folderPath, props['level-name']))) {
      worldFolders.push(props['level-name']);
    }

    // Find startup scripts & runnable jars
    const launchCandidates: ImportLaunchCandidate[] = [];
    const seenScripts = new Set<string>();

    const addScriptCandidate = (fileName: string) => {
      if (seenScripts.has(fileName.toLowerCase())) return;
      seenScripts.add(fileName.toLowerCase());
      let containsPause = false;
      try {
        const content = fs.readFileSync(path.join(folderPath, fileName), 'utf8');
        containsPause = /^\s*(pause\b|Read-Host\b)/im.test(content);
      } catch {
        // ignore
      }
      launchCandidates.push({
        label: fileName,
        script: fileName,
        recommended: false,
        containsPause,
      });
    };

    for (const pref of SCRIPT_PRIORITY) {
      const actual = entryNamesLower.get(pref);
      if (actual) addScriptCandidate(actual);
    }

    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.bat') || lower.endsWith('.cmd') || lower.endsWith('.ps1') || lower.endsWith('.sh')) {
        addScriptCandidate(e.name);
      }
    }

    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.jar') && !lower.includes('installer')) {
        launchCandidates.push({
          label: `${e.name} (Java JAR)`,
          script: e.name,
          recommended: false,
        });
      }
    }

    // If the selected root folder has NO server files at all, look for nested server folders
    // (common when extracting CurseForge/ATM10 server ZIPs into a named wrapper folder like "ATM 10\Server-Files-2.47").
    const rootHasServerFiles = Boolean(
      hasServerProperties ||
        modCount > 0 ||
        modloader !== null ||
        worldFolders.length > 0 ||
        launchCandidates.length > 0 ||
        entryNamesLower.has('user_jvm_args.txt')
    );

    let detectedSubfolders: DetectedServerSubfolder[] | undefined;
    if (!rootHasServerFiles && allowNestedAutoResolve) {
      const nested = findNestedServerDirs(folderPath, 3);
      if (nested.length === 1) {
        const resolved = this.inspectDirectory(nested[0].path, false);
        resolved.autoResolvedFrom = folderPath;
        if (GENERIC_PACK_SUBFOLDER_RE.test(path.basename(nested[0].path))) {
          const parentLabel = path.basename(folderPath);
          if (parentLabel) {
            resolved.suggestedName = parentLabel;
          }
        }
        return resolved;
      }
      if (nested.length > 1) {
        detectedSubfolders = nested;
      }
    }

    // Mark first platform-matching candidate as recommended
    const isWin = process.platform === 'win32';
    let preferredIdx = launchCandidates.findIndex((c) =>
      isWin ? c.script.toLowerCase().endsWith('.bat') || c.script.toLowerCase().endsWith('.cmd') : c.script.toLowerCase().endsWith('.sh')
    );
    if (preferredIdx < 0 && isWin) {
      preferredIdx = launchCandidates.findIndex((c) => c.script.toLowerCase().endsWith('.ps1'));
    }
    if (preferredIdx >= 0) {
      launchCandidates[preferredIdx].recommended = true;
    } else if (launchCandidates.length > 0) {
      launchCandidates[0].recommended = true;
    } else {
      warnings.push(
        detectedSubfolders && detectedSubfolders.length > 1
          ? `Found ${detectedSubfolders.length} server subfolders inside this folder — select the one you want to import above.`
          : 'No startup script (.bat/.ps1/.sh) or server .jar was found in the root of this folder. You may need to specify the startup script manually or select the subfolder containing startserver.bat / run.bat / server.properties.'
      );
    }

    // Detect RAM allocation from user_jvm_args.txt, variables.txt, or launch scripts
    let detectedMemoryMb = isModdedMc ? 8192 : 4096;
    const ramFiles = ['user_jvm_args.txt', 'variables.txt', ...launchCandidates.map((c) => c.script).filter((s) => !s.endsWith('.jar'))];
    for (const f of ramFiles) {
      const full = path.join(folderPath, f);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        try {
          const parsed = parseXmxMemoryMb(fs.readFileSync(full, 'utf8'));
          if (parsed && parsed >= 1024) {
            detectedMemoryMb = parsed;
            break;
          }
        } catch {
          // ignore
        }
      }
    }

    const gamePort = Number.parseInt(props['server-port'] || '25565', 10) || 25565;
    const rconPort = Number.parseInt(props['rcon.port'] || '25575', 10) || 25575;
    const rconCurrentlyEnabled = String(props['enable-rcon'] || '').toLowerCase() === 'true';

    if (!hasServerProperties && modCount === 0 && worldFolders.length === 0 && !(detectedSubfolders && detectedSubfolders.length > 0)) {
      warnings.push(
        'This folder does not contain server.properties, a mods/ directory, or a world folder yet. Double-check that you selected the server root folder.'
      );
    }

    if (hasServerProperties && !rconCurrentlyEnabled) {
      warnings.push(
        'RCON is currently disabled in server.properties. Leave "Auto-enable RCON" checked below so ServerForge can read live player counts and run safe save-all commands before stopping.'
      );
    }

    const recommendedCandidate = launchCandidates.find((c) => c.recommended);
    if (recommendedCandidate?.containsPause) {
      warnings.push(
        `Detected "pause" at the end of ${recommendedCandidate.script}. ServerForge will still stop the server cleanly via RCON and process-tree cleanup.`
      );
    }

    const detectedConfig: Record<string, string | number | boolean> = {
      MOTD: props['motd'] || path.basename(folderPath) || 'Imported Minecraft Server',
      MAX_PLAYERS: Number.parseInt(props['max-players'] || '10', 10) || 10,
      DIFFICULTY: props['difficulty'] || 'normal',
      GAMEMODE: props['gamemode'] || 'survival',
      VIEW_DISTANCE: Number.parseInt(props['view-distance'] || '10', 10) || 10,
      ONLINE_MODE: props['online-mode'] ? props['online-mode'].toLowerCase() !== 'false' : true,
      RCON_PASSWORD: props['rcon.password'] || '',
    };

    const detectedGameId = isModdedMc ? 'minecraft-curseforge' : 'minecraft';
    const detectedGameName = isModdedMc
      ? `Minecraft Modded (${modloader || 'Modpack'})`
      : `Minecraft (${modloader || 'Java'})`;

    return {
      folderPath,
      suggestedName: path.basename(folderPath) || detectedGameName,
      detectedGameId,
      detectedGameName,
      modloader,
      modCount,
      worldFolders,
      hasServerProperties,
      rconCurrentlyEnabled,
      launchCandidates,
      detectedPorts: { game: gamePort, rcon: rconPort },
      detectedMemoryMb,
      detectedConfig,
      warnings,
      detectedSubfolders,
    };
  }

  browseDirectory(rawDir?: string): FolderBrowseResult {
    const trimmed = (rawDir || '').trim();

    // On Windows with empty path, list available drive letters (C:\, D:\, ...)
    if (!trimmed && process.platform === 'win32') {
      const drives: FolderBrowseEntry[] = [];
      for (let code = 67; code <= 90; code++) {
        const letter = `${String.fromCharCode(code)}:\\`;
        try {
          if (fs.existsSync(letter)) {
            drives.push({ name: letter, path: letter });
          }
        } catch {
          // skip unreadable drive
        }
      }
      return {
        currentPath: '',
        parentPath: null,
        directories: drives,
        currentFolderHint: null,
        previewFiles: [],
      };
    }

    const targetDir = trimmed ? path.resolve(trimmed) : os.homedir();
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      throw new Error(`Directory not found: ${targetDir}`);
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const rawDirs: Array<{ name: string; path: string }> = [];
    const previewFiles: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('$') || entry.name === 'System Volume Information') continue;
        rawDirs.push({
          name: entry.name,
          path: path.join(targetDir, entry.name),
        });
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          lower === 'server.properties' ||
          lower === 'user_jvm_args.txt' ||
          lower === 'eula.txt' ||
          lower.endsWith('.bat') ||
          lower.endsWith('.cmd') ||
          lower.endsWith('.ps1') ||
          lower.endsWith('.sh') ||
          lower.endsWith('.jar') ||
          lower === 'palserver.exe' ||
          lower === 'factoryserver.exe'
        ) {
          previewFiles.push(entry.name);
        }
      }
    }

    rawDirs.sort((a, b) => a.name.localeCompare(b.name));
    previewFiles.sort((a, b) => a.localeCompare(b));

    const currentProbe = probeServerFolder(targetDir);
    const directories: FolderBrowseEntry[] = rawDirs.map((d, idx) => {
      if (idx < 60) {
        const probe = probeServerFolder(d.path);
        if (probe.isServerFolder) {
          return {
            ...d,
            isServerFolder: true,
            serverHint: probe.hint ?? undefined,
          };
        }
      }
      return d;
    });

    const parsedParent = path.dirname(targetDir);
    const parentPath =
      parsedParent === targetDir ? (process.platform === 'win32' ? '' : null) : parsedParent;

    return {
      currentPath: targetDir,
      parentPath,
      directories,
      currentFolderHint: currentProbe.isServerFolder ? currentProbe.summary : null,
      previewFiles: previewFiles.slice(0, 12),
    };
  }

  /**
   * Opens the native Windows 11 File Explorer "Select Folder" dialog on the
   * host PC so users get a familiar OS file picker instead of a custom web grid.
   */
  async pickNativeFolder(initialDir?: string): Promise<FolderPickResult> {
    if (process.platform !== 'win32') {
      return {
        supported: false,
        cancelled: false,
        folderPath: null,
        reason: 'Native File Explorer folder picker is available when running on Windows.',
      };
    }

    if (this.activeFolderPick) {
      return this.activeFolderPick;
    }

    const cleanInitial = initialDir?.trim().replace(/^["']|["']$/g, '') || '';
    const script = buildWindowsFolderPickerScript(cleanInitial, false);
    const encoded = encodePowerShellCommand(script);

    this.activeFolderPick = new Promise<FolderPickResult>((resolve) => {
      execFile(
        'powershell.exe',
        ['-STA', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { timeout: 120_000, windowsHide: true },
        (err, stdout) => {
          this.activeFolderPick = null;
          if (err && !stdout.trim()) {
            resolve({
              supported: false,
              cancelled: false,
              folderPath: null,
              reason: err.killed
                ? 'Folder picker timed out. Try again or use the Web Browser.'
                : err.message,
            });
            return;
          }
          try {
            const parsed = JSON.parse(stdout.trim()) as FolderPickResult;
            resolve({
              supported: Boolean(parsed.supported),
              cancelled: Boolean(parsed.cancelled),
              folderPath: parsed.folderPath || null,
              reason: parsed.reason,
            });
          } catch {
            resolve({
              supported: false,
              cancelled: false,
              folderPath: null,
              reason: 'Could not read folder selection from Windows Explorer.',
            });
          }
        }
      );
    });

    return this.activeFolderPick;
  }

  private async queryJavaWorkingDirViaJcmd(pid: number, javaExePath: string): Promise<string | null> {
    if (!javaExePath) return null;
    const jcmdPath = path.win32.join(path.win32.dirname(javaExePath), 'jcmd.exe');
    if (!fs.existsSync(jcmdPath)) return null;

    return new Promise((resolve) => {
      execFile(
        jcmdPath,
        [String(pid), 'VM.system_properties'],
        { timeout: 3_000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          resolve(parseJavaUserDirFromProperties(stdout));
        }
      );
    });
  }

  async discoverRunningServers(): Promise<DiscoveredProcess[]> {
    if (process.platform !== 'win32') {
      return [];
    }

    const psScript = `
try {
  if (-not ('SfProcCwd' -as [type])) {
    Add-Type -TypeDefinition @'
${WINDOWS_PEB_CWD_CSHARP}
'@ -Language CSharp -ErrorAction Stop
  }
} catch {}

$hasPebHelper = [bool]('SfProcCwd' -as [type])
$targets = @('java.exe', 'javaw.exe', 'ArkAscendedServer.exe', 'PalServer.exe', 'PalServer-Win64-Shipping-Cmd.exe', 'FactoryServer.exe', 'factorio.exe')
$allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
$byPid = @{}
foreach ($ap in $allProcs) {
  $byPid[[int]$ap.ProcessId] = $ap
}

$found = @()
foreach ($p in $allProcs) {
  if ($targets -notcontains $p.Name) { continue }
  $cmd = [string]$p.CommandLine
  $exe = [string]$p.ExecutablePath
  if ($p.Name -match 'java' -and $cmd -notmatch '(?i)(server|forge|neoforge|fabric|paper|purpur|spigot|velocity|nogui|user_jvm_args|win_args|bootstraplauncher)') {
    continue
  }

  $cwd = $null
  if ($hasPebHelper) {
    try {
      $cwd = [SfProcCwd]::GetWorkingDirectory([int]$p.ProcessId)
    } catch {}
  }

  $ancestors = @()
  $cursorPid = [int]$p.ParentProcessId
  $depth = 0
  while ($cursorPid -gt 0 -and $depth -lt 3 -and $byPid.ContainsKey($cursorPid)) {
    $parentObj = $byPid[$cursorPid]
    if ($parentObj.Name -match '(?i)^(java|javaw|cmd|powershell|pwsh)\\.exe$') {
      if ($parentObj.CommandLine) {
        $ancestors += [string]$parentObj.CommandLine
      }
      if (-not $cwd -and $hasPebHelper -and $parentObj.Name -match '(?i)^(java|javaw)\\.exe$') {
        try {
          $cwd = [SfProcCwd]::GetWorkingDirectory([int]$parentObj.ProcessId)
        } catch {}
      }
      $cursorPid = [int]$parentObj.ParentProcessId
      $depth++
    } else {
      break
    }
  }

  $found += [PSCustomObject]@{
    pid = [int]$p.ProcessId
    parentPid = [int]$p.ParentProcessId
    processName = [string]$p.Name
    executablePath = $exe
    commandLine = $cmd
    processCwd = $cwd
    ancestorCommandLines = $ancestors
  }
}
$found | ConvertTo-Json -Depth 4 -Compress
`;

    const encoded = encodePowerShellCommand(psScript);

    const rawList = await new Promise<RawDiscoveredProcess[]>((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { timeout: 15_000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve([]);
            return;
          }
          try {
            const parsed = JSON.parse(stdout.trim());
            const list = Array.isArray(parsed) ? parsed : [parsed];
            resolve(list as RawDiscoveredProcess[]);
          } catch {
            resolve([]);
          }
        }
      );
    });

    const normalized = normalizeDiscoveredProcesses(rawList);

    // Final async fallback: if a Java process still lacks workingDir (e.g. AV blocked PEB read),
    // try sibling jcmd.exe <pid> VM.system_properties.
    const exeByPid = new Map(rawList.map((r) => [r.pid, r.executablePath || '']));
    for (const proc of normalized) {
      if (!proc.workingDir && proc.processName.toLowerCase().includes('java')) {
        const javaExe = exeByPid.get(proc.pid) || '';
        const jcmdDir = await this.queryJavaWorkingDirViaJcmd(proc.pid, javaExe);
        if (jcmdDir) {
          proc.workingDir = jcmdDir;
        }
      }
    }

    return normalized;
  }
}
