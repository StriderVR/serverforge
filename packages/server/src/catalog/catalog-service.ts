import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { GameTemplateSchema, type GameTemplate } from '@serverforge/shared';

export interface CatalogTemplateEntry {
  template: GameTemplate;
  rawYaml: string;
  filePath: string;
  isCustom: boolean;
}

export const DEFAULT_BUILTIN_CONNECT_STEPS: Readonly<Record<string, readonly string[]>> = {
  'ark-survival-ascended': [
    'Launch Ark: Survival Ascended and wait for any server mods to finish syncing if prompted.',
    'Open the in-game console (~) and run: open {address}',
    'Alternatively, go to Join Game -> Unofficial (enable Show Player Servers) and search for the server name.',
  ],
  factorio: [
    'Launch Factorio (make sure your game version matches the server).',
    'Click Multiplayer -> Connect to address.',
    'Enter {address} and click Connect (sync mods if prompted).',
  ],
  minecraft: [
    'Open Minecraft: Java Edition using the matching game version (and loader/mods if modded).',
    'Click Multiplayer -> Add Server (or Direct Connection).',
    'Enter {address} as the Server Address and click Join Server.',
  ],
  'minecraft-curseforge': [
    'Install the matching CurseForge modpack and version using the CurseForge App (or Prism Launcher).',
    'Launch Minecraft through that modpack profile.',
    'Go to Multiplayer -> Add Server, enter {address}, and click Join Server.',
  ],
  'minecraft-modrinth': [
    'Install the matching Modrinth modpack and version using the Modrinth App (or Prism Launcher).',
    'Launch Minecraft through that modpack profile.',
    'Go to Multiplayer -> Add Server, enter {address}, and click Join Server.',
  ],
  palworld: [
    'Launch Palworld and click Join Multiplayer Game.',
    'At the bottom of the server browser, enter {address} into the direct-connect field.',
    'If the server requires a join password, check Enter Password and click Connect.',
  ],
  satisfactory: [
    'Launch Satisfactory and open Server Manager from the main menu.',
    'Click Add Server, enter {host} as the Address and {port} as the Port, then confirm.',
    'Accept the server certificate prompt if shown, select the server, and click Join Game.',
  ],
};

export class CatalogService {
  private templates = new Map<string, CatalogTemplateEntry>();

  constructor(
    private readonly builtInDir: string,
    private readonly customDir: string
  ) {
    fs.mkdirSync(this.customDir, { recursive: true });
    this.reload();
  }

  reload(): void {
    this.templates.clear();
    this.loadDirectory(this.builtInDir, false);
    this.loadDirectory(this.customDir, true);
  }

  private loadDirectory(dir: string, isCustom: boolean): void {
    if (!fs.existsSync(dir)) return;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const rawYaml = fs.readFileSync(filePath, 'utf8');
        const parsed = YAML.parse(rawYaml);
        const template = GameTemplateSchema.parse({ ...parsed, isCustom });
        if (!isCustom && template.id === 'minecraft') {
          if (!template.group) {
            template.group = 'minecraft';
            template.groupName = template.groupName ?? 'Minecraft';
            template.groupDescription =
              template.groupDescription ??
              'Dedicated Minecraft Java Edition server — choose Standard (Vanilla, Paper, Fabric, Forge, NeoForge) or one-click CurseForge modpacks with automatic Java 8/17/21/25.';
            template.variantLabel = template.variantLabel ?? 'Standard (Vanilla / Paper / Fabric)';
            template.variantDescription =
              template.variantDescription ?? 'Vanilla, Paper plugins, Fabric, Forge, NeoForge, or Modrinth';
            template.variantOrder = template.variantOrder ?? 1;
          }
        }
        if (!isCustom && template.id === 'minecraft-curseforge') {
          if (!template.group) {
            template.group = 'minecraft';
            template.groupName = template.groupName ?? 'Minecraft';
            template.variantLabel = template.variantLabel ?? 'CurseForge Modpack';
            template.variantDescription =
              template.variantDescription ??
              'Browse & auto-install CurseForge modpacks (ATM, Better MC, RLCraft, etc.)';
            template.variantOrder = template.variantOrder ?? 2;
          }
          const javaField = template.configFields.find((f) => f.key === 'JAVA_IMAGE_TAG');
          if (javaField && Array.isArray(javaField.options) && !javaField.options.includes('java25')) {
            javaField.options = ['java25', ...javaField.options];
            if (javaField.description && !javaField.description.includes('Java 25')) {
              javaField.description =
                'Java 25 for MC 26.1+ (e.g. ATM11), Java 21 for MC 1.20.5-1.21.x, Java 17 for MC 1.18-1.20.4, Java 8 for MC 1.16.5 and older. Auto-installed natively if missing.';
            }
          }
        }
        if (!isCustom && template.id === 'factorio') {
          const existingKeys = new Set(template.configFields.map((f) => f.key));
          if (!existingKeys.has('FACTORIO_SOURCE')) {
            template.configFields.push({
              key: 'FACTORIO_SOURCE',
              label: 'Factorio Install Folder, ZIP Path, or URL (Optional)',
              description:
                'Leave blank to auto-detect Steam/local Factorio on Windows (or auto-download the free official headless server on Linux/WSL).',
              type: 'string',
              default: '',
              required: false,
              autoGenerate: false,
            });
          }
          if (!existingKeys.has('FACTORIO_USERNAME')) {
            template.configFields.push({
              key: 'FACTORIO_USERNAME',
              label: 'Factorio.com Username (Optional, Windows ZIP Auto-Download)',
              description:
                'Optional — paired with your Factorio.com Token to auto-download the official Windows 64-bit ZIP without Steam.',
              type: 'string',
              default: '',
              required: false,
              autoGenerate: false,
            });
          }
          if (!existingKeys.has('FACTORIO_TOKEN')) {
            template.configFields.push({
              key: 'FACTORIO_TOKEN',
              label: 'Factorio.com Auth Token (Optional)',
              description:
                'Found on https://factorio.com/profile (only needed if auto-downloading the Windows ZIP without Steam or WSL).',
              type: 'secret',
              default: '',
              required: false,
              autoGenerate: false,
            });
          }
        }
        if (!isCustom && template.id === 'satisfactory') {
          if (!template.ports.some((p) => p.key === 'reliable')) {
            template.ports.push({
              key: 'reliable',
              label: 'Reliable Messaging Port (1.1+)',
              defaultPort: 8888,
              protocol: 'tcp',
              internalOnly: false,
              primary: false,
            });
          }
        }
        if (!isCustom && (!template.connectSteps || template.connectSteps.length === 0)) {
          const defaultSteps = DEFAULT_BUILTIN_CONNECT_STEPS[template.id];
          if (defaultSteps) {
            template.connectSteps = [...defaultSteps];
          }
        }
        this.templates.set(template.id, { template, rawYaml, filePath, isCustom });
      } catch (err) {
        console.error(`[CatalogService] Failed to parse template ${filePath}:`, err);
      }
    }
  }

  listTemplates(): GameTemplate[] {
    return Array.from(this.templates.values())
      .map((entry) => entry.template)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getTemplate(id: string): GameTemplate | null {
    return this.templates.get(id)?.template ?? null;
  }

  getTemplateYaml(id: string): string | null {
    return this.templates.get(id)?.rawYaml ?? null;
  }

  validateYaml(rawYaml: string): { valid: true; template: GameTemplate } | { valid: false; errors: string[] } {
    try {
      const parsed = YAML.parse(rawYaml);
      if (!parsed || typeof parsed !== 'object') {
        return { valid: false, errors: ['YAML document must be a key-value object.'] };
      }
      const result = GameTemplateSchema.safeParse({ ...parsed, isCustom: true });
      if (!result.success) {
        return {
          valid: false,
          errors: result.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
        };
      }
      return { valid: true, template: result.data };
    } catch (err) {
      return {
        valid: false,
        errors: [err instanceof Error ? err.message : 'Invalid YAML syntax'],
      };
    }
  }

  importCustomTemplate(rawYaml: string): GameTemplate {
    const validation = this.validateYaml(rawYaml);
    if (!validation.valid) {
      throw new Error(`Invalid game template YAML:\n${validation.errors.join('\n')}`);
    }
    const { template } = validation;
    const existing = this.templates.get(template.id);
    if (existing && !existing.isCustom) {
      throw new Error(`Template ID "${template.id}" conflicts with a built-in template. Pick a different ID.`);
    }

    const filePath = path.join(this.customDir, `${template.id}.yaml`);
    fs.writeFileSync(filePath, rawYaml.trim() + '\n', 'utf8');
    this.templates.set(template.id, { template, rawYaml, filePath, isCustom: true });
    return template;
  }

  deleteCustomTemplate(id: string): boolean {
    const entry = this.templates.get(id);
    if (!entry || !entry.isCustom) {
      return false;
    }
    if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath);
    }
    this.templates.delete(id);
    return true;
  }
}

/**
 * Renders mustache-style {{VAR}} placeholders using config fields, allocated ports,
 * memory limit, and host information.
 */
export function renderTemplateString(
  templateStr: string,
  variables: Record<string, string | number | boolean>
): string {
  return templateStr.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const val = variables[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

export function buildTemplateVariables(params: {
  config: Record<string, string | number | boolean>;
  ports: Record<string, number>;
  memoryLimitMb: number;
  publicHost?: string;
}): Record<string, string | number | boolean> {
  const vars: Record<string, string | number | boolean> = {
    ...params.config,
    MEMORY_MB: params.memoryLimitMb,
    HOST: params.publicHost || 'localhost',
  };
  for (const [key, port] of Object.entries(params.ports)) {
    vars[`PORT_${key.toUpperCase()}`] = port;
  }
  return vars;
}
