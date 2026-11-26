import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createServerForgeApp } from './api/server.js';
import { isSeaExecutable, WORKSPACE_ROOT } from './config.js';

function openBrowserOnWindows(url: string): void {
  if (process.platform !== 'win32' || process.env.NO_OPEN_BROWSER === '1') return;
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Ignore if browser cannot be opened automatically
  }
}

async function main() {
  const sf = await createServerForgeApp();
  await sf.orchestrator.reconcileOnStartup();
  await sf.network.start(3000);
  sf.leaseReaper.start(30_000);
  sf.backupScheduler.start(60_000);
  sf.maintenance.start(60_000);
  await sf.discord.start();

  await sf.app.listen({ host: sf.config.host, port: sf.config.port });

  const localUrl = `http://${sf.config.host === '0.0.0.0' ? 'localhost' : sf.config.host}:${sf.config.port}`;
  const netStatus = sf.network.getStatusSync();

  console.log('');
  console.log('======================================================');
  console.log(`  ServerForge v${sf.config.appVersion} Control Plane is ONLINE`);
  console.log(`  Dashboard:    ${localUrl}`);
  console.log(`  Public Host:  ${netStatus.effectiveHost} (${netStatus.effectiveHostSource})`);
  console.log(`  Data Folder:  ${WORKSPACE_ROOT}`);
  console.log(`  Runtime Mode: ${sf.config.runtimeMode}`);
  console.log(`  Templates:    ${sf.catalog.listTemplates().length} games loaded`);
  console.log(`  Discord Bot:  ${sf.config.discordToken ? 'Connecting...' : 'Disabled (set DISCORD_TOKEN in .env)'}`);
  console.log('======================================================');
  console.log('  Keep this window open while running game servers.');
  console.log('  Press Ctrl+C to save and shut down cleanly.');
  console.log('');

  if (isSeaExecutable()) {
    openBrowserOnWindows(localUrl);
  }

  // 1. Resume any servers remembered across a self-update or managed PC reboot
  const resumeResult = await sf.updater.resumeServersOnStartup();
  const skipAutoStart = new Set(resumeResult.resumedIds);

  // 2. Start any permanent servers marked 'Auto-Start on PC Boot'
  const autoStartedIds = await sf.orchestrator.startAutoStartInstances(skipAutoStart);

  if (resumeResult.postRebootNotify) {
    const totalBooted = resumeResult.resumedIds.length + autoStartedIds.length;
    setTimeout(() => {
      void sf.discord.sendChannelNotice(
        'Server PC Back Online',
        totalBooted > 0
          ? `ServerForge v${sf.config.appVersion} is back online after reboot and automatically started ${totalBooted} game server(s).`
          : `ServerForge v${sf.config.appVersion} is back online after reboot. Use \`/server start\` to boot a game server.`,
        0x10b981
      );
    }, 5000).unref?.();
  }

  // 3. Optional auto-update check on startup (only if enabled in Settings)
  const settings = sf.db.getSettings(sf.config.publicHost);
  if (settings.autoUpdateOnBoot && resumeResult.reason !== 'update') {
    setTimeout(async () => {
      try {
        const status = await sf.updater.checkForUpdates(true);
        if (status.updateAvailable && status.installMode === 'exe') {
          console.log(`[AutoUpdate] Newer release v${status.latestVersion} detected on startup — applying update...`);
          await sf.updater.applyUpdate({
            resumeRunningServers: true,
            actor: 'AutoUpdateOnBoot',
            onShutdownRequested: async () => {
              const forceExit = setTimeout(() => process.exit(0), 2500);
              forceExit.unref?.();
              try {
                await sf.close();
              } finally {
                process.exit(0);
              }
            },
          });
        }
      } catch (err) {
        console.error('[AutoUpdate] Startup update check skipped:', err);
      }
    }, 15_000).unref?.();
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[ServerForge] Received ${signal}, saving running servers & shutting down cleanly...`);
    try {
      await sf.orchestrator.stopAllRunning('System', 'system', `Host shutdown (${signal})`);
    } catch {
      // ignore during forced exit
    }
    await sf.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
}

main().catch((err) => {
  console.error('[ServerForge] Fatal startup error:', err);
  if (isSeaExecutable() && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nPress Enter to exit...', () => {
      rl.close();
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
});
