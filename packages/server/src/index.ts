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
  sf.leaseReaper.start(30_000);
  await sf.discord.start();

  await sf.app.listen({ host: sf.config.host, port: sf.config.port });

  const localUrl = `http://${sf.config.host === '0.0.0.0' ? 'localhost' : sf.config.host}:${sf.config.port}`;

  console.log('');
  console.log('======================================================');
  console.log('  ServerForge Control Plane is ONLINE');
  console.log(`  Dashboard:    ${localUrl}`);
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

  const shutdown = async (signal: string) => {
    console.log(`\n[ServerForge] Received ${signal}, shutting down cleanly...`);
    await sf.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
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
