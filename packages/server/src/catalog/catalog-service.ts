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
