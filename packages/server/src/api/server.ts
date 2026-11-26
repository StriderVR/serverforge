import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  BackupPolicySchema,
  CreateInstanceInputSchema,
  FirewallApplyInputSchema,
  ImportServerInputSchema,
  StartInstanceInputSchema,
  SystemSettingsSchema,
  UpdateInstanceConfigInputSchema,
  type DiagnosticLevel,
  type WsServerEvent,
} from '@serverforge/shared';
interface WsClient {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
import { AuthService, type AuthTokenPayload } from '../auth/auth-service.js';
import { CatalogService } from '../catalog/catalog-service.js';
import { loadConfig, type AppConfig } from '../config.js';
import { AppDatabase } from '../db/database.js';
import { DiscordBotService } from '../discord/bot.js';
import { EMBEDDED_WEB_ASSETS } from '../embedded-assets.js';
import { QueryService } from '../query/query-service.js';
import { RuntimeManager } from '../runtimes/runtime-manager.js';
import { BackupSchedulerService } from '../services/backup-scheduler.js';
import { ConnectivityService } from '../services/connectivity-service.js';
import { CurseForgeService, normalizeCurseForgeApiKey } from '../services/curseforge-service.js';
import { DiagnosticsService } from '../services/diagnostics-service.js';
import {
  FileSecurityError,
  FileService,
  FileValidationError,
  MAX_UPLOAD_FILE_BYTES,
} from '../services/file-service.js';
import { FirewallService, type FirewallExecFn } from '../services/firewall-service.js';
import { SmartImportService } from '../services/import-service.js';
import { LeaseReaper } from '../services/lease-reaper.js';
import { MaintenanceService, type OsRebootExecutor } from '../services/maintenance-service.js';
import {
  isMinecraftInstance,
  MinecraftPropertiesService,
} from '../services/minecraft-properties-service.js';
import { ModrinthService } from '../services/modrinth-service.js';
import { NetworkAddressService, normalizeDuckDnsDomain } from '../services/network-service.js';
import { GuardrailError, ServerOrchestrator } from '../services/orchestrator.js';
import { TelemetryService } from '../services/telemetry-service.js';
import { UpdaterService } from '../services/updater-service.js';

const AUTH_COOKIE = 'sf_token';

function formatZodIssues(prefix: string, issues: Array<{ path: (string | number)[]; message: string }>): string {
  if (!issues || issues.length === 0) return prefix;
  const detail = issues
    .slice(0, 4)
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  return `${prefix}: ${detail}`;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthTokenPayload;
  }
}

export interface CreateAppOptions extends Partial<AppConfig> {
  fetchImpl?: typeof fetch;
  osRebootExecutor?: OsRebootExecutor;
  detectDuckDnsDomainsImpl?: () => Promise<string[]>;
  detectLanIpImpl?: () => string | null;
  firewallExecImpl?: FirewallExecFn;
  platformOverride?: NodeJS.Platform;
  probePollDelayMs?: number;
}

export interface ServerForgeApp {
  app: FastifyInstance;
  config: AppConfig;
  db: AppDatabase;
  auth: AuthService;
  catalog: CatalogService;
  runtimeManager: RuntimeManager;
  telemetry: TelemetryService;
  network: NetworkAddressService;
  firewall: FirewallService;
  connectivity: ConnectivityService;
  diagnostics: DiagnosticsService;
  orchestrator: ServerOrchestrator;
  backupScheduler: BackupSchedulerService;
  leaseReaper: LeaseReaper;
  discord: DiscordBotService;
  curseforge: CurseForgeService;
  modrinth: ModrinthService;
  fileService: FileService;
  minecraftProps: MinecraftPropertiesService;
  smartImport: SmartImportService;
  updater: UpdaterService;
  maintenance: MaintenanceService;
  close: () => Promise<void>;
}

export async function createServerForgeApp(overrides: CreateAppOptions = {}): Promise<ServerForgeApp> {
  const {
    fetchImpl,
    osRebootExecutor,
    detectDuckDnsDomainsImpl,
    detectLanIpImpl,
    firewallExecImpl,
    platformOverride,
    probePollDelayMs,
    ...configOverrides
  } = overrides;
  const config = loadConfig(configOverrides);
  const db = new AppDatabase(config.dbPath);
  const auth = new AuthService(db, config.jwtSecret);
  const catalog = new CatalogService(config.catalogDir, config.customCatalogDir);
  const queryService = new QueryService();

  const getEffectiveCurseForgeKey = () => {
    const settings = db.getSettings(config.publicHost);
    return normalizeCurseForgeApiKey(settings.curseforgeApiKey || config.curseforgeApiKey || '');
  };

  const curseforge = new CurseForgeService(fetchImpl);
  const modrinth = new ModrinthService(fetchImpl, config.appVersion);
  const fileService = new FileService();
  const minecraftProps = new MinecraftPropertiesService();
  const runtimeManager = new RuntimeManager(
    config.runtimeMode,
    config.toolsDir,
    queryService,
    () => ({
      CF_API_KEY: getEffectiveCurseForgeKey(),
    }),
    curseforge,
    fetchImpl,
    modrinth
  );

  let discordStatusFn = () => ({ connected: false, botTag: null as string | null });
  const telemetry = new TelemetryService(db, runtimeManager, () => discordStatusFn(), config.publicHost);
  const network = new NetworkAddressService(config, db, {
    fetchImpl,
    detectDuckDnsDomainsImpl,
    detectLanIpImpl,
  });
  const firewall = new FirewallService({
    platform: platformOverride,
    tmpDir: path.join(config.dataDir, 'tmp'),
    execImpl: firewallExecImpl,
  });
  const connectivity = new ConnectivityService(config, db, catalog, network, firewall, {
    platform: platformOverride,
    fetchImpl,
    execImpl: firewallExecImpl,
    probePollDelayMs,
  });
  const diagnostics = new DiagnosticsService(config, db, telemetry);
  const orchestrator = new ServerOrchestrator(
    config,
    db,
    catalog,
    runtimeManager,
    telemetry,
    network,
    diagnostics,
    undefined,
    curseforge,
    modrinth
  );
  orchestrator.attachFirewallService(firewall);
  diagnostics.attachOrchestrator(orchestrator);
  diagnostics.attachConnectivity(connectivity);
  const backupScheduler = new BackupSchedulerService(db, orchestrator);
  const leaseReaper = new LeaseReaper(config, db, catalog, orchestrator);
  const discord = new DiscordBotService(config, db, catalog, orchestrator, fetchImpl);
  const smartImport = new SmartImportService();
  const updater = new UpdaterService(config, db, orchestrator, fetchImpl);
  const maintenance = new MaintenanceService(config, db, orchestrator, updater, osRebootExecutor);
  discordStatusFn = () => discord.getStatus();

  const app = Fastify({ logger: false, bodyLimit: MAX_UPLOAD_FILE_BYTES });

  // Gracefully allow empty bodies even if a client sends Content-Type: application/json (e.g., DELETE requests)
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const raw = typeof body === 'string' ? body.trim() : '';
    if (!raw) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err instanceof Error ? err : new Error('Invalid JSON payload'), undefined);
    }
  });

  // Binary file upload parser for in-browser drag-and-drop mod/config uploads (#12)
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_FILE_BYTES },
    (_req, body, done) => {
      done(null, body);
    }
  );

  // Capture unhandled Fastify errors and 4xx/5xx API responses into DiagnosticsService
  app.addHook('onError', async (req, reply, err) => {
    if (!req.url.startsWith('/api/')) return;
    diagnostics.record({
      level: 'error',
      source: 'api',
      statusCode: reply.statusCode >= 400 ? reply.statusCode : 500,
      method: req.method,
      path: req.url,
      message: err.message || 'Unhandled API error',
      details: err.stack?.split('\n').slice(0, 6).join('\n') ?? null,
    });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/') && reply.statusCode >= 400) {
      // Skip expected unauthenticated probes
      if (reply.statusCode === 401 && (req.url === '/api/auth/me' || req.url.startsWith('/api/instances'))) {
        return payload;
      }
      let message = `HTTP ${reply.statusCode}`;
      if (typeof payload === 'string') {
        try {
          const parsed = JSON.parse(payload) as { error?: string; message?: string };
          if (parsed.error || parsed.message) {
            message = parsed.error || parsed.message || message;
          }
        } catch {
          if (payload.trim()) message = payload.trim().slice(0, 220);
        }
      }
      const instanceMatch = req.url.match(/^\/api\/instances\/([^/?]+)/);
      diagnostics.record({
        level: reply.statusCode >= 500 ? 'error' : 'warn',
        source: 'api',
        statusCode: reply.statusCode,
        method: req.method,
        path: req.url,
        instanceId: instanceMatch?.[1] ?? null,
        message,
      });
    }
    return payload;
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(websocket);

  const extractToken = (req: FastifyRequest): string | null => {
    const cookieToken = req.cookies?.[AUTH_COOKIE];
    if (cookieToken) return cookieToken;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      return header.slice(7).trim();
    }
    return null;
  };

  const requireAuth = async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const token = extractToken(req);
    if (!token) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    const payload = auth.verifyToken(token);
    if (!payload) {
      return reply.status(401).send({ error: 'Invalid or expired session' });
    }
    req.authUser = payload;
  };

  // --- Health & Auth ---

  app.get('/api/health', async () => ({
    status: 'ok',
    version: config.appVersion,
    runtimeMode: config.runtimeMode,
    needsSetup: auth.needsInitialSetup(),
  }));

  app.get('/api/auth/me', async (req) => {
    const needsSetup = auth.needsInitialSetup();
    const token = extractToken(req);
    const user = token ? auth.verifyToken(token) : null;
    return {
      needsSetup,
      authenticated: Boolean(user),
      user: user ? { id: user.sub, username: user.username, role: user.role } : null,
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    const body = req.body as { username?: string; password?: string } | undefined;
    if (!body?.username || !body?.password) {
      return reply.status(400).send({ error: 'Username and password are required.' });
    }
    try {
      const { user, token } = auth.setupInitialAdmin(body.username, body.password);
      reply.setCookie(AUTH_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 7,
      });
      return {
        user: { id: user.id, username: user.username, role: user.role },
        token,
      };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Setup failed' });
    }
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = req.body as { username?: string; password?: string } | undefined;
    if (!body?.username || !body?.password) {
      return reply.status(400).send({ error: 'Username and password are required.' });
    }
    const res = auth.login(body.username, body.password);
    if (!res) {
      return reply.status(401).send({ error: 'Invalid username or password.' });
    }
    reply.setCookie(AUTH_COOKIE, res.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    return {
      user: { id: res.user.id, username: res.user.username, role: res.user.role },
      token: res.token,
    };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  });

  // --- Protected API Routes ---

  app.get('/api/host/metrics', { preHandler: requireAuth }, async () => {
    return telemetry.getHostMetrics(orchestrator.getRunningCount());
  });

  app.get('/api/settings', { preHandler: requireAuth }, async () => {
    return db.getSettings(config.publicHost);
  });

  app.put('/api/settings', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = SystemSettingsSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodIssues('Invalid settings payload', parsed.error.issues), issues: parsed.error.issues });
    }
    const previous = db.getSettings(config.publicHost);
    const patch = { ...parsed.data };
    if (typeof patch.curseforgeApiKey === 'string') {
      patch.curseforgeApiKey = normalizeCurseForgeApiKey(patch.curseforgeApiKey);
    }
    if (typeof patch.duckdnsDomain === 'string' && patch.duckdnsDomain.trim()) {
      patch.duckdnsDomain = normalizeDuckDnsDomain(patch.duckdnsDomain) || patch.duckdnsDomain.trim();
    }
    if (typeof patch.discordBotToken === 'string') {
      patch.discordBotToken = patch.discordBotToken.trim();
    }
    const updated = db.saveSettings(patch, config.publicHost);
    db.addAuditLog({
      actor: req.authUser?.username || 'admin',
      source: 'web',
      action: 'settings.update',
      instanceId: null,
      details: 'Updated system & Discord guardrails settings',
    });

    // Re-sync slash commands automatically when switching the target Discord guild while connected
    if (discord.getStatus().connected && updated.discordGuildId !== previous.discordGuildId) {
      void discord.resyncSlashCommands().catch(() => {});
    }
    if (discord.getStatus().connected && updated.discordStatusPanelChannelId) {
      discord.scheduleStatusPanelUpdate();
    }

    return updated;
  });

  // --- Discord Bot Setup, Discovery & Live Status Panel ---

  app.get('/api/discord/status', { preHandler: requireAuth }, async () => {
    return discord.getDiscoveryStatus();
  });

  app.post('/api/discord/connect', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { token?: string } | undefined;
    try {
      const status = await discord.connectWithToken(body?.token);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'discord.connect',
        instanceId: null,
        details: `Connected Discord bot as ${status.botTag ?? 'unknown'}`,
      });
      return status;
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Failed to connect Discord bot',
      });
    }
  });

  app.post('/api/discord/disconnect', { preHandler: requireAuth }, async (req) => {
    const body = req.body as { clearToken?: boolean } | undefined;
    const status = await discord.disconnect(Boolean(body?.clearToken));
    db.addAuditLog({
      actor: req.authUser?.username || 'admin',
      source: 'web',
      action: 'discord.disconnect',
      instanceId: null,
      details: body?.clearToken ? 'Disconnected Discord bot and cleared saved token' : 'Disconnected Discord bot',
    });
    return status;
  });

  app.post('/api/discord/sync-commands', { preHandler: requireAuth }, async (_req, reply) => {
    try {
      return await discord.resyncSlashCommands();
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Failed to sync slash commands',
      });
    }
  });

  app.post('/api/discord/test-message', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { channelId?: string } | undefined;
    try {
      return await discord.sendTestNotification(body?.channelId);
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Failed to send Discord test alert',
      });
    }
  });

  app.post('/api/discord/panel', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { channelId?: string; repost?: boolean } | undefined;
    try {
      const res = await discord.postOrUpdateStatusPanel(body?.channelId, Boolean(body?.repost));
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'discord.panel',
        instanceId: null,
        details: `${res.updatedExisting ? 'Refreshed' : 'Posted'} live Discord status panel in channel ${res.channelId}`,
      });
      return res;
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Failed to post Discord status panel',
      });
    }
  });

  // --- Network & DuckDNS Public Address Discovery ---

  app.get('/api/network/status', { preHandler: requireAuth }, async (req) => {
    const q = req.query as { refresh?: string };
    return network.getStatus(q.refresh === '1' || q.refresh === 'true');
  });

  app.post('/api/network/detect', { preHandler: requireAuth }, async () => {
    return network.refresh(true);
  });

  app.post('/api/network/duckdns/update', { preHandler: requireAuth }, async (req) => {
    const body = req.body as
      | { domain?: string; token?: string; saveOnSuccess?: boolean; autoUpdate?: boolean }
      | undefined;
    const result = await network.updateDuckDns({
      domain: body?.domain,
      token: body?.token,
    });
    let saved = false;
    if (result.ok && body?.saveOnSuccess !== false) {
      const settingsPatch: Partial<import('@serverforge/shared').SystemSettings> = {
        duckdnsDomain: result.domain,
        publicHostMode: 'duckdns',
      };
      if (body?.token !== undefined && body.token.trim()) {
        settingsPatch.duckdnsToken = body.token.trim();
      }
      if (body?.autoUpdate !== undefined) {
        settingsPatch.duckdnsAutoUpdate = Boolean(body.autoUpdate);
      }
      db.saveSettings(settingsPatch, config.publicHost);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'settings.duckdns_updated',
        instanceId: null,
        details: `Verified and updated DuckDNS domain ${result.domain}`,
      });
      saved = true;
    }
    return {
      ...result,
      saved,
      status: network.getStatusSync(),
    };
  });

  app.get('/api/network/port-map', { preHandler: requireAuth }, async () => {
    return {
      lanIp: network.getStatusSync().lanIp,
      entries: connectivity.buildConsolidatedPortMap(orchestrator.listInstances()),
    };
  });

  app.get('/api/instances/:id/network-guide', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Server instance not found.' });
    return connectivity.buildNetworkGuide(inst);
  });

  app.get('/api/instances/:id/firewall', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Server instance not found.' });
    const template = catalog.getTemplate(inst.gameId);
    return firewall.inspectInstance(inst, template);
  });

  app.post('/api/instances/:id/firewall/apply', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Server instance not found.' });
    const parsed = FirewallApplyInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodIssues('Invalid firewall request', parsed.error.issues) });
    }
    const template = catalog.getTemplate(inst.gameId);
    const result = await firewall.applyInstanceRules(inst, template, {
      switchProfileToPrivate: parsed.data.switchProfileToPrivate,
    });
    if (result.ok) {
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.firewall_applied',
        instanceId: inst.id,
        details: `Applied least-privilege Private-profile Windows Firewall rules for ${inst.name} (${result.method})`,
      });
    }
    return result;
  });

  app.delete('/api/instances/:id/firewall', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Server instance not found.' });
    const result = await firewall.removeInstanceRules(inst, { allowUac: true });
    if (result.ok) {
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.firewall_removed',
        instanceId: inst.id,
        details: result.message,
      });
    }
    return result;
  });

  app.post('/api/instances/:id/network-check', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Server instance not found.' });
    return connectivity.runConnectivityCheck(inst);
  });

  app.get('/api/audit', { preHandler: requireAuth }, async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 250);
    return db.listAuditLogs(limit);
  });

  // --- Game Catalog ---

  app.get('/api/catalog', { preHandler: requireAuth }, async () => {
    return catalog.listTemplates();
  });

  app.get('/api/catalog/:id/yaml', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const raw = catalog.getTemplateYaml(id);
    if (!raw) return reply.status(404).send({ error: 'Template not found' });
    return { id, yaml: raw };
  });

  app.post('/api/catalog/validate', { preHandler: requireAuth }, async (req) => {
    const body = req.body as { yaml?: string } | undefined;
    return catalog.validateYaml(body?.yaml ?? '');
  });

  app.post('/api/catalog/import', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { yaml?: string } | undefined;
    if (!body?.yaml) {
      return reply.status(400).send({ error: 'YAML content is required.' });
    }
    try {
      const template = catalog.importCustomTemplate(body.yaml);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'catalog.import',
        instanceId: null,
        details: `Imported custom game template "${template.name}" (${template.id})`,
      });
      return reply.status(201).send(template);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Import failed' });
    }
  });

  app.delete('/api/catalog/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = catalog.deleteCustomTemplate(id);
    if (!deleted) {
      return reply.status(400).send({ error: 'Only custom imported templates can be deleted.' });
    }
    return { ok: true };
  });

  // --- Server Instances ---

  const withJoinInfo = <T extends import('@serverforge/shared').ServerInstance>(inst: T) => ({
    ...inst,
    ...orchestrator.getJoinAddressInfo(inst),
  });

  app.get('/api/instances', { preHandler: requireAuth }, async () => {
    return orchestrator.listInstances().map((inst) => withJoinInfo(inst));
  });

  app.get('/api/instances/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    return {
      ...withJoinInfo(inst),
      logs: orchestrator.logs.getLines(inst.id),
      backups: db.listBackups(inst.id),
    };
  });

  app.post('/api/instances', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = CreateInstanceInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: formatZodIssues('Invalid instance configuration', parsed.error.issues), issues: parsed.error.issues });
    }

    try {
      let inst = orchestrator.createInstance(parsed.data, req.authUser?.username || 'admin', 'web');
      if (parsed.data.startImmediately) {
        inst = await orchestrator.startInstance(inst.id, {
          temporary: false,
          requestedBy: req.authUser?.username || 'admin',
          source: 'web',
        });
      }
      return reply.status(201).send(withJoinInfo(inst));
    } catch (err) {
      const status = err instanceof GuardrailError ? 409 : 400;
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Failed to create instance' });
    }
  });

  app.patch('/api/instances/:id/config', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateInstanceConfigInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: formatZodIssues('Invalid config update', parsed.error.issues), issues: parsed.error.issues });
    }
    try {
      const updated = orchestrator.updateInstanceConfig(id, parsed.data, req.authUser?.username || 'admin');
      return withJoinInfo(updated);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  app.post('/api/instances/:id/start', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = StartInstanceInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: formatZodIssues('Invalid start options', parsed.error.issues), issues: parsed.error.issues });
    }
    try {
      const started = await orchestrator.startInstance(id, {
        ...parsed.data,
        requestedBy: parsed.data.requestedBy || req.authUser?.username || 'admin',
        source: 'web',
      });
      return withJoinInfo(started);
    } catch (err) {
      const status = err instanceof GuardrailError ? 409 : 400;
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Failed to start server' });
    }
  });

  app.post('/api/instances/:id/stop', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const stopped = await orchestrator.stopInstance(id, req.authUser?.username || 'admin', 'web');
      return withJoinInfo(stopped);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Failed to stop server' });
    }
  });

  app.post('/api/instances/:id/restart', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const restarted = await orchestrator.restartInstance(id, req.authUser?.username || 'admin');
      return withJoinInfo(restarted);
    } catch (err) {
      const status = err instanceof GuardrailError ? 409 : 400;
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Failed to restart server' });
    }
  });

  app.post('/api/instances/:id/command', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { command?: string } | undefined;
    if (!body?.command?.trim()) {
      return reply.status(400).send({ error: 'Command cannot be empty.' });
    }
    try {
      const response = await orchestrator.sendCommand(id, body.command.trim(), req.authUser?.username || 'admin');
      return { ok: true, response };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Command failed' });
    }
  });

  app.post('/api/instances/:id/lease/extend', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { minutes?: number } | undefined;
    const minutes = Math.min(Math.max(Number(body?.minutes) || 60, 15), 480);
    try {
      return orchestrator.extendLease(id, minutes, req.authUser?.username || 'admin', 'web');
    } catch (err) {
      const status = err instanceof GuardrailError ? 409 : 400;
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'Failed to extend lease' });
    }
  });

  app.post('/api/instances/:id/lease/promote', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return orchestrator.promoteToPermanent(id, req.authUser?.username || 'admin');
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Failed to promote lease' });
    }
  });

  app.get('/api/instances/:id/backups', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    return {
      backups: db.listBackups(inst.id),
      policy: inst.backupPolicy ?? BackupPolicySchema.parse({}),
    };
  });

  app.post('/api/instances/:id/backups', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { note?: string; applyRetention?: boolean } | undefined;
    try {
      const inst = orchestrator.getInstance(id);
      const applyRetention = body?.applyRetention ?? Boolean(inst?.backupPolicy?.enabled);
      const backup = await orchestrator.createBackup(id, body?.note, req.authUser?.username || 'admin', {
        source: 'web',
        applyRetention,
      });
      return reply.status(201).send(backup);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Backup failed' });
    }
  });

  app.put('/api/instances/:id/backups/policy', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = BackupPolicySchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: formatZodIssues('Invalid backup policy', parsed.error.issues), issues: parsed.error.issues });
    }
    try {
      const updated = orchestrator.updateBackupPolicy(id, parsed.data, req.authUser?.username || 'admin');
      return {
        policy: updated.backupPolicy,
        instance: withJoinInfo(updated),
      };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Failed to update backup policy' });
    }
  });

  app.get('/api/instances/:id/backups/:backupId/download', { preHandler: requireAuth }, async (req, reply) => {
    const { id, backupId } = req.params as { id: string; backupId: string };
    try {
      const { record, filePath } = orchestrator.getBackupDownload(id, backupId);
      const safeName = record.filename.replace(/["\r\n]/g, '');
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      reply.header('Content-Length', String(fs.statSync(filePath).size));
      return reply.send(fs.createReadStream(filePath));
    } catch (err) {
      return reply.status(404).send({ error: err instanceof Error ? err.message : 'Backup not found' });
    }
  });

  app.post('/api/instances/:id/backups/:backupId/restore', { preHandler: requireAuth }, async (req, reply) => {
    const { id, backupId } = req.params as { id: string; backupId: string };
    try {
      const result = await orchestrator.restoreBackup(id, backupId, req.authUser?.username || 'admin');
      return { ok: true, ...result };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Restore failed' });
    }
  });

  app.delete('/api/instances/:id/backups/:backupId', { preHandler: requireAuth }, async (req, reply) => {
    const { id, backupId } = req.params as { id: string; backupId: string };
    try {
      const deleted = orchestrator.deleteBackup(id, backupId, req.authUser?.username || 'admin', 'web');
      return { ok: true, deleted };
    } catch (err) {
      return reply.status(404).send({ error: err instanceof Error ? err.message : 'Backup not found' });
    }
  });

  // --- In-Browser File Manager & Config Editor Routes (Issue #12) ---

  const mapFileErrorStatus = (err: unknown): number => {
    if (err instanceof FileSecurityError) return 403;
    if (err instanceof FileValidationError) return 400;
    return 500;
  };

  app.get('/api/instances/:id/files', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relPath = '' } = req.query as { path?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      return fileService.listDirectory(rootDir, relPath);
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Failed to list files' });
    }
  });

  app.get('/api/instances/:id/files/content', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relPath = '' } = req.query as { path?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      return fileService.readTextFile(rootDir, relPath);
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Failed to read file' });
    }
  });

  app.put('/api/instances/:id/files/content', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: string; content?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    if (typeof body.path !== 'string' || typeof body.content !== 'string') {
      return reply.status(400).send({ error: 'Both "path" and "content" strings are required.' });
    }
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      const saved = fileService.writeTextFile(rootDir, body.path, body.content);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.file_edit',
        instanceId: inst.id,
        details: `Edited ${saved.path} (${saved.sizeBytes} bytes)`,
      });
      return saved;
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Failed to save file' });
    }
  });

  app.post('/api/instances/:id/files/mkdir', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      const created = fileService.createDirectory(rootDir, body.path ?? '');
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.file_mkdir',
        instanceId: inst.id,
        details: `Created folder ${created.path}`,
      });
      return created;
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Failed to create directory' });
    }
  });

  app.post('/api/instances/:id/files/upload', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { dir = '', filename = '' } = req.query as { dir?: string; filename?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    const rawBody = req.body;
    const buffer = Buffer.isBuffer(rawBody)
      ? rawBody
      : typeof rawBody === 'string'
        ? Buffer.from(rawBody, 'utf8')
        : null;
    if (!buffer) {
      return reply.status(400).send({ error: 'Binary upload body (application/octet-stream) is required.' });
    }
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      const entry = fileService.uploadFile(rootDir, dir, filename, buffer);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.file_upload',
        instanceId: inst.id,
        details: `Uploaded ${entry.path} (${entry.sizeBytes} bytes)`,
      });
      return reply.status(201).send(entry);
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Upload failed' });
    }
  });

  app.get('/api/instances/:id/files/download', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relPath = '' } = req.query as { path?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      const info = fileService.getDownloadInfo(rootDir, relPath);
      const safeName = info.filename.replace(/["\r\n]/g, '');
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${safeName}"`);
      reply.header('Content-Length', String(info.sizeBytes));
      return reply.send(fs.createReadStream(info.filePath));
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Download failed' });
    }
  });

  app.post('/api/instances/:id/files/rename', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: string; newName?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      const result = fileService.renameEntry(rootDir, body.path ?? '', body.newName ?? '');
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.file_rename',
        instanceId: inst.id,
        details: `Renamed ${result.fromPath} -> ${result.toPath}`,
      });
      return result;
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Rename failed' });
    }
  });

  app.delete('/api/instances/:id/files', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: relPath = '' } = req.query as { path?: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    try {
      const rootDir = orchestrator.getServerContentDir(inst);
      const result = fileService.deleteEntry(rootDir, relPath);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.file_delete',
        instanceId: inst.id,
        details: `Deleted ${result.deletedPath}`,
      });
      return { ok: true, ...result };
    } catch (err) {
      return reply.status(mapFileErrorStatus(err)).send({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  // --- Minecraft server.properties Editor Routes (Issue #36) ---

  app.get('/api/instances/:id/minecraft/properties', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    if (!isMinecraftInstance(inst)) {
      return reply.status(400).send({ error: 'server.properties editor is only available for Minecraft instances.' });
    }
    const serverDir = orchestrator.getServerContentDir(inst);
    return minecraftProps.read(serverDir, inst);
  });

  app.put('/api/instances/:id/minecraft/properties', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    if (!isMinecraftInstance(inst)) {
      return reply.status(400).send({ error: 'server.properties editor is only available for Minecraft instances.' });
    }
    const body = (req.body ?? {}) as {
      properties?: Record<string, string>;
      rawContent?: string;
      createIfMissing?: boolean;
      allowManagedOverride?: boolean;
      restartAfterSave?: boolean;
    };
    try {
      const serverDir = orchestrator.getServerContentDir(inst);
      const updated = minecraftProps.write(serverDir, inst, body);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.minecraft_properties',
        instanceId: inst.id,
        details: `Updated server.properties${body.restartAfterSave ? ' (with restart)' : ''}`,
      });
      if (body.restartAfterSave && inst.status === 'running') {
        await orchestrator.restartInstance(inst.id, req.authUser?.username || 'admin');
        const refreshed = orchestrator.getInstance(inst.id) ?? inst;
        return { ...minecraftProps.read(serverDir, refreshed), restarted: true };
      }
      return { ...updated, restarted: false };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Failed to save server.properties' });
    }
  });

  // --- Modrinth & Minecraft Mods / Plugins Manager Routes (Issue #14) ---

  app.get('/api/modrinth/search', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as {
      q?: string;
      type?: 'modpack' | 'mod' | 'plugin';
      loader?: string;
      version?: string;
      limit?: string;
    };
    const projectType = q.type === 'modpack' || q.type === 'plugin' ? q.type : 'mod';
    try {
      const results = await modrinth.searchProjects({
        query: q.q ?? '',
        projectType,
        loader: q.loader,
        gameVersion: q.version,
        limit: q.limit ? Number(q.limit) : 15,
      });
      return { results };
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'Modrinth search failed' });
    }
  });

  app.get('/api/modrinth/projects/:projectId/versions', { preHandler: requireAuth }, async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const q = req.query as { loader?: string; version?: string };
    try {
      const versions = await modrinth.getProjectVersions(projectId, {
        loader: q.loader,
        gameVersion: q.version,
      });
      return { versions };
    } catch (err) {
      return reply.status(502).send({ error: err instanceof Error ? err.message : 'Failed to load Modrinth versions' });
    }
  });

  app.get('/api/instances/:id/addons', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    const serverDir = orchestrator.getServerContentDir(inst);
    return modrinth.listInstalledAddons(serverDir, inst);
  });

  app.post('/api/instances/:id/addons/install', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    const body = (req.body ?? {}) as {
      projectId?: string;
      versionId?: string;
      folder?: 'mods' | 'plugins';
      loader?: string;
      gameVersion?: string;
    };
    if (!body.projectId?.trim()) {
      return reply.status(400).send({ error: 'projectId is required.' });
    }
    try {
      const serverDir = orchestrator.getServerContentDir(inst);
      const result = await modrinth.installAddonWithDependencies(serverDir, inst, {
        projectId: body.projectId.trim(),
        versionId: body.versionId?.trim() || undefined,
        folder: body.folder,
        loader: body.loader,
        gameVersion: body.gameVersion,
      });
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.addon_install',
        instanceId: inst.id,
        details: `Installed ${result.installed.map((i) => i.filename).join(', ')}`,
      });
      return { ok: true, ...result };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Addon install failed' });
    }
  });

  app.post('/api/instances/:id/addons/toggle', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    const body = (req.body ?? {}) as { filename?: string; folder?: 'mods' | 'plugins' };
    if (!body.filename || (body.folder !== 'mods' && body.folder !== 'plugins')) {
      return reply.status(400).send({ error: 'filename and folder ("mods" | "plugins") are required.' });
    }
    try {
      const serverDir = orchestrator.getServerContentDir(inst);
      const res = modrinth.toggleAddon(serverDir, body.folder, body.filename);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.addon_toggle',
        instanceId: inst.id,
        details: `${res.enabled ? 'Enabled' : 'Disabled'} ${body.folder}/${res.filename}`,
      });
      return { ok: true, ...res };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Toggle failed' });
    }
  });

  app.delete('/api/instances/:id/addons', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    const q = req.query as { filename?: string; folder?: 'mods' | 'plugins' };
    if (!q.filename || (q.folder !== 'mods' && q.folder !== 'plugins')) {
      return reply.status(400).send({ error: 'filename and folder query params are required.' });
    }
    try {
      const serverDir = orchestrator.getServerContentDir(inst);
      modrinth.removeAddon(serverDir, q.folder, q.filename);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'instance.addon_delete',
        instanceId: inst.id,
        details: `Removed ${q.folder}/${q.filename}`,
      });
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Remove failed' });
    }
  });

  app.get('/api/instances/:id/addons/updates', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    const serverDir = orchestrator.getServerContentDir(inst);
    const updates = await modrinth.checkAddonUpdates(serverDir, inst);
    return { updates };
  });

  // --- One-Click Game Server & Modpack Updater Routes (Issue #13) ---

  app.get('/api/instances/:id/update-check', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await orchestrator.checkInstanceUpdate(id);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Update check failed' });
    }
  });

  app.post('/api/instances/:id/update', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      createBackup?: boolean;
      targetVersionId?: string;
      restartIfRunning?: boolean;
    };
    try {
      return await orchestrator.updateInstance(id, body, req.authUser?.username || 'admin');
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  // --- Diagnostics & Console Log Download Routes ---

  app.get('/api/instances/:id/logs/download', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    const text = orchestrator.logs.getFormattedText(inst.id);
    const safeSlug = inst.slug.replace(/[^a-zA-Z0-9._-]/g, '-');
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${safeSlug}-console.log"`);
    return reply.send(text || '(No console output recorded yet)\n');
  });

  app.get('/api/instances/:id/debug-report', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = orchestrator.getInstance(id);
    if (!inst) return reply.status(404).send({ error: 'Instance not found' });
    return diagnostics.buildInstanceDebugReport(inst);
  });

  app.get('/api/diagnostics/logs', { preHandler: requireAuth }, async (req) => {
    const q = req.query as { level?: string; limit?: string };
    const level =
      q.level === 'error' || q.level === 'warn' || q.level === 'info' ? (q.level as DiagnosticLevel) : undefined;
    const limit = q.limit ? Number(q.limit) : 100;
    return diagnostics.listLogs({ level, limit: Number.isFinite(limit) ? limit : 100 });
  });

  app.delete('/api/diagnostics/logs', { preHandler: requireAuth }, async (req) => {
    diagnostics.clearLogs();
    db.addAuditLog({
      actor: req.authUser?.username || 'admin',
      source: 'web',
      action: 'diagnostics.clear',
      instanceId: null,
      details: 'Cleared backend diagnostic logs',
    });
    return { ok: true };
  });

  app.get('/api/diagnostics/report', { preHandler: requireAuth }, async () => {
    return diagnostics.buildSystemReport();
  });

  app.delete('/api/instances/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await orchestrator.deleteInstance(id, req.authUser?.username || 'admin');
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Delete failed' });
    }
  });

  // --- WebSocket Live Console & Telemetry Stream ---

  const wsClients = new Set<WsClient>();

  const broadcast = (event: WsServerEvent) => {
    const payload = JSON.stringify(event);
    for (const sock of wsClients) {
      if (sock.readyState === 1) {
        sock.send(payload);
      }
    }
  };

  // --- App Self-Updater Routes ---

  app.get('/api/updater/status', { preHandler: requireAuth }, async (req) => {
    const q = req.query as { refresh?: string };
    return updater.checkForUpdates(q.refresh === '1' || q.refresh === 'true');
  });

  app.get('/api/updater/log', { preHandler: requireAuth }, async () => ({
    log: updater.getLastUpdateLog(),
  }));

  app.post('/api/updater/apply', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { resumeRunningServers?: boolean; dryRun?: boolean } | undefined;
    const resumeRunningServers = body?.resumeRunningServers ?? true;
    const actor = req.authUser?.username || 'admin';

    const forceShutdown = async () => {
      // Hard exit timer ensures open browser HTTP/WS keep-alive sockets never block .exe swap
      const hardExit = setTimeout(() => process.exit(0), 2500);
      hardExit.unref?.();
      try {
        await close();
      } finally {
        process.exit(0);
      }
    };

    if (body?.dryRun) {
      try {
        const result = await updater.applyUpdate({
          resumeRunningServers,
          dryRun: true,
          actor,
          onProgress: (ev) => broadcast({ type: 'updater:progress', ...ev }),
          onShutdownRequested: async () => {},
        });
        return { ok: true, restarting: false, ...result };
      } catch (err) {
        return reply.status(400).send({ error: err instanceof Error ? err.message : 'Update failed' });
      }
    }

    if (updater.isUpdating()) {
      return reply.status(409).send({ error: 'An update is already in progress.' });
    }

    const status = await updater.checkForUpdates(true);
    if (status.error) {
      return reply.status(400).send({ error: status.error });
    }
    if (!status.latestVersion) {
      return reply.status(400).send({ error: 'No GitHub Release found to update to.' });
    }
    if (status.installMode === 'exe' && !status.exeDownloadUrl) {
      return reply.status(400).send({ error: `Release v${status.latestVersion} has no ServerForge.exe asset.` });
    }

    // Run download, server save/stop, and Windows EXE swap asynchronously while streaming progress over WebSocket
    void updater
      .applyUpdate({
        resumeRunningServers,
        dryRun: false,
        actor,
        onProgress: (ev) => broadcast({ type: 'updater:progress', ...ev }),
        onShutdownRequested: forceShutdown,
      })
      .catch((err) => {
        console.error('[Updater] Background update failed:', err);
      });

    return reply.status(202).send({
      ok: true,
      accepted: true,
      restarting: true,
      targetVersion: status.latestVersion,
      rememberedServers: resumeRunningServers ? status.runningServers.length : 0,
    });
  });

  // --- Maintenance & Managed Daily PC Reboot Routes ---

  app.get('/api/maintenance/status', { preHandler: requireAuth }, async () => {
    return maintenance.getStatus();
  });

  app.post('/api/maintenance/reboot', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { resumeRunningServers?: boolean; reason?: string } | undefined;
    try {
      const res = await maintenance.triggerRebootNow({
        resumeRunningServers: body?.resumeRunningServers ?? true,
        actor: req.authUser?.username || 'admin',
        source: 'web',
        reason: body?.reason?.trim() || 'Manual reboot from Web Dashboard',
      });
      return { ok: true, rebooting: true, ...res };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Reboot failed' });
    }
  });

  app.get('/api/maintenance/inspect-reboots', { preHandler: requireAuth }, async () => {
    return maintenance.inspectWindowsAutoReboots();
  });

  app.post('/api/maintenance/disable-task', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { taskPath?: string; taskName?: string } | undefined;
    if (!body?.taskName) {
      return reply.status(400).send({ error: 'taskName is required.' });
    }
    try {
      await maintenance.disableWindowsScheduledTask(
        body.taskPath || '\\',
        body.taskName,
        req.authUser?.username || 'admin'
      );
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Could not disable task' });
    }
  });

  // --- CurseForge Modpack Search & Files Proxy Routes ---

  app.get('/api/curseforge/status', { preHandler: requireAuth }, async () => ({
    configured: Boolean(getEffectiveCurseForgeKey()),
  }));

  app.post('/api/curseforge/test', { preHandler: requireAuth }, async (req) => {
    const body = req.body as { apiKey?: string; saveOnSuccess?: boolean } | undefined;
    const keyToTest = body?.apiKey !== undefined ? body.apiKey : getEffectiveCurseForgeKey();
    const result = await curseforge.testApiKey(keyToTest);
    let saved = false;
    if (result.ok && body?.saveOnSuccess !== false && result.normalizedKey) {
      db.saveSettings({ curseforgeApiKey: result.normalizedKey }, config.publicHost);
      db.addAuditLog({
        actor: req.authUser?.username || 'admin',
        source: 'web',
        action: 'settings.curseforge_key_verified',
        instanceId: null,
        details: 'Verified and saved CurseForge Core API key',
      });
      saved = true;
    }
    return { ...result, saved };
  });

  app.get('/api/curseforge/search', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as { q?: string; limit?: string };
    try {
      const results = await curseforge.searchModpacks(
        q.q ?? '',
        getEffectiveCurseForgeKey(),
        Number(q.limit) || 12
      );
      return results;
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'CurseForge search failed' });
    }
  });

  app.get('/api/curseforge/mods/:modId/files', { preHandler: requireAuth }, async (req, reply) => {
    const { modId } = req.params as { modId: string };
    const idNum = Number.parseInt(modId, 10);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      return reply.status(400).send({ error: 'Invalid modId' });
    }
    try {
      const files = await curseforge.getModpackFiles(idNum, getEffectiveCurseForgeKey());
      return files;
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Could not fetch modpack versions' });
    }
  });

  app.get('/api/curseforge/mods/:modId/files/:fileId/download-url', { preHandler: requireAuth }, async (req, reply) => {
    const { modId, fileId } = req.params as { modId: string; fileId: string };
    try {
      const url = await curseforge.getServerPackDownloadUrl(
        Number.parseInt(modId, 10),
        Number.parseInt(fileId, 10),
        getEffectiveCurseForgeKey()
      );
      return { url };
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Failed to resolve download URL' });
    }
  });

  // --- Smart Server Import Routes ---

  app.get('/api/import/discover', { preHandler: requireAuth }, async () => {
    return smartImport.discoverRunningServers();
  });

  app.get('/api/import/browse', { preHandler: requireAuth }, async (req, reply) => {
    const q = req.query as { dir?: string };
    try {
      return smartImport.browseDirectory(q.dir);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Unable to browse directory' });
    }
  });

  app.post('/api/import/pick-folder', { preHandler: requireAuth }, async (req) => {
    const body = req.body as { initialDir?: string } | undefined;
    return smartImport.pickNativeFolder(body?.initialDir);
  });

  app.post('/api/import/inspect', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as { folderPath?: string } | undefined;
    if (!body?.folderPath?.trim()) {
      return reply.status(400).send({ error: 'folderPath is required.' });
    }
    try {
      return smartImport.inspectDirectory(body.folderPath);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Inspection failed' });
    }
  });

  app.post('/api/import/execute', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = ImportServerInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid import configuration', issues: parsed.error.issues });
    }
    try {
      const imported = orchestrator.importInstance(parsed.data, req.authUser?.username || 'admin');
      return reply.status(201).send(withJoinInfo(imported));
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Import failed' });
    }
  });

  orchestrator.on('console:line', (data) => {
    broadcast({ type: 'console:line', ...data });
  });
  orchestrator.on('instance:update', (instance) => {
    broadcast({ type: 'instance:update', instance });
  });
  orchestrator.on('instance:deleted', (instanceId) => {
    broadcast({ type: 'instance:deleted', instanceId });
  });
  orchestrator.on('instance:crash', ({ instance, crash }) => {
    broadcast({
      type: 'instance:crash',
      instanceId: instance.id,
      instanceName: instance.name,
      crash,
    });
  });
  orchestrator.on('lease:warning', ({ lease, instance, reason, minutesRemaining }) => {
    broadcast({
      type: 'lease:warning',
      lease,
      instanceName: instance.name,
      reason,
      minutesRemaining,
    });
  });

  maintenance.on('notice', (notice: { kind: 'warning' | 'deferred' | 'rebooting' | 'online'; message: string }) => {
    broadcast({ type: 'maintenance:notice', ...notice });
    const titleMap = {
      warning: 'Scheduled Maintenance Reboot Warning',
      deferred: 'Maintenance Reboot Deferred',
      rebooting: 'Server PC Rebooting',
      online: 'Server PC Back Online',
    };
    const colorMap = {
      warning: 0xf59e0b,
      deferred: 0x0ea5e9,
      rebooting: 0xef4444,
      online: 0x10b981,
    };
    void discord.sendChannelNotice(titleMap[notice.kind], notice.message, colorMap[notice.kind]);
  });

  const metricsTimer = setInterval(async () => {
    if (wsClients.size === 0) return;
    try {
      const metrics = await telemetry.getHostMetrics(orchestrator.getRunningCount());
      broadcast({ type: 'host:metrics', metrics });
    } catch {
      // ignore transient telemetry error
    }
  }, 5000);
  metricsTimer.unref?.();

  app.get('/ws', { websocket: true }, (socket, req) => {
    const token = extractToken(req);
    if (!token || !auth.verifyToken(token)) {
      socket.close(4001, 'Unauthorized');
      return;
    }
    wsClients.add(socket);
    socket.on('close', () => {
      wsClients.delete(socket);
    });
  });

  // --- Serve Compiled React Web UI in Production / Standalone EXE ---

  const embeddedKeys = Object.keys(EMBEDDED_WEB_ASSETS);
  if (embeddedKeys.length > 0) {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.status(404).send({ error: 'Route not found' });
      }
      const cleanPath = req.url.split('?')[0].replace(/^\/+/, '');
      const asset = EMBEDDED_WEB_ASSETS[cleanPath] ?? EMBEDDED_WEB_ASSETS['index.html'];
      if (!asset) {
        return reply.status(404).send({ error: 'Asset not found' });
      }
      reply.header('Content-Type', asset.mimeType);
      if (cleanPath.startsWith('assets/')) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return reply.send(Buffer.from(asset.contentBase64, 'base64'));
    });
  } else if (fs.existsSync(path.join(config.webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: '/',
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.status(404).send({ error: 'Route not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  const close = async () => {
    clearInterval(metricsTimer);
    network.stop();
    backupScheduler.stop();
    leaseReaper.stop();
    maintenance.stop();
    orchestrator.dispose();
    await discord.stop();
    for (const sock of wsClients) {
      sock.close();
    }
    wsClients.clear();
    await app.close();
    db.close();
  };

  maintenance.setShutdownHandler(close);

  return {
    app,
    config,
    db,
    auth,
    catalog,
    runtimeManager,
    telemetry,
    network,
    firewall,
    connectivity,
    diagnostics,
    orchestrator,
    backupScheduler,
    leaseReaper,
    discord,
    curseforge,
    modrinth,
    fileService,
    minecraftProps,
    smartImport,
    updater,
    maintenance,
    close,
  };
}
