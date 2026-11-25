import { createServerForgeApp } from './api/server.js';

async function main() {
  const sf = await createServerForgeApp();
  await sf.orchestrator.reconcileOnStartup();
  sf.leaseReaper.start(30_000);
  await sf.discord.start();

  await sf.app.listen({ host: sf.config.host, port: sf.config.port });

  console.log('');
  console.log('======================================================');
  console.log('  ServerForge Control Plane is ONLINE');
  console.log(`  Dashboard:    http://${sf.config.host === '0.0.0.0' ? 'localhost' : sf.config.host}:${sf.config.port}`);
  console.log(`  Runtime Mode: ${sf.config.runtimeMode}`);
  console.log(`  Templates:    ${sf.catalog.listTemplates().length} games loaded`);
  console.log(`  Discord Bot:  ${sf.config.discordToken ? 'Connecting...' : 'Disabled (set DISCORD_TOKEN in .env)'}`);
  console.log('======================================================');
  console.log('');

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
  process.exit(1);
});
