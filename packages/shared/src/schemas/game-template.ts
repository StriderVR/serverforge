import { z } from 'zod';

export const RuntimeKindSchema = z.enum(['docker', 'native']);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

export const PortProtocolSchema = z.enum(['tcp', 'udp', 'both']);
export type PortProtocol = z.infer<typeof PortProtocolSchema>;

export const PortSpecSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  defaultPort: z.number().int().min(1024).max(65535),
  protocol: PortProtocolSchema,
  internalOnly: z.boolean().optional().default(false),
  primary: z.boolean().optional().default(false),
});
export type PortSpec = z.infer<typeof PortSpecSchema>;

export const VolumeSpecSchema = z.object({
  hostSubdir: z.string().min(1),
  containerPath: z.string().min(1),
});
export type VolumeSpec = z.infer<typeof VolumeSpecSchema>;

export const DockerRuntimeSpecSchema = z.object({
  image: z.string().min(1),
  volumes: z.array(VolumeSpecSchema).default([]),
  envTemplate: z.record(z.string(), z.string()).default({}),
  command: z.array(z.string()).optional(),
  stopSignal: z.string().optional(),
});
export type DockerRuntimeSpec = z.infer<typeof DockerRuntimeSpecSchema>;

export const NativeInstallerSchema = z.enum(['steamcmd', 'java', 'download', 'custom']);
export type NativeInstaller = z.infer<typeof NativeInstallerSchema>;

export const NativeRuntimeSpecSchema = z.object({
  installer: NativeInstallerSchema,
  steamAppId: z.number().int().positive().optional(),
  steamBeta: z.string().optional(),
  downloadUrlTemplate: z.string().optional(),
  executableWindows: z.string().min(1),
  executableLinux: z.string().min(1).optional(),
  argsTemplate: z.string().default(''),
  envTemplate: z.record(z.string(), z.string()).default({}),
  workingSubdir: z.string().optional(),
  saveSubdir: z.string().default('data'),
});
export type NativeRuntimeSpec = z.infer<typeof NativeRuntimeSpecSchema>;

export const QueryProtocolSchema = z.enum([
  'rcon',
  'minecraft-slp',
  'palworld-rest',
  'satisfactory-api',
  'none',
]);
export type QueryProtocol = z.infer<typeof QueryProtocolSchema>;

export const QuerySpecSchema = z.object({
  protocol: QueryProtocolSchema.default('none'),
  portKey: z.string().optional(),
  rconPortKey: z.string().optional(),
  passwordField: z.string().optional(),
  username: z.string().optional(),
  listPlayersCommand: z.string().optional(),
  listPlayersPattern: z.string().optional(),
  listPlayersCountRegex: z.string().optional(),
});
export type QuerySpec = z.infer<typeof QuerySpecSchema>;

export const LifecycleSpecSchema = z.object({
  bootGraceSeconds: z.number().int().min(15).max(1800).default(180),
  gracefulStopTimeoutSeconds: z.number().int().min(5).max(300).default(60),
  saveCommand: z.string().optional(),
  stopCommand: z.string().optional(),
  saveMethod: z.enum(['rcon', 'palworld-rest', 'stdin', 'none']).default('none'),
});
export type LifecycleSpec = z.infer<typeof LifecycleSpecSchema>;

export const ConfigFieldTypeSchema = z.enum(['string', 'number', 'boolean', 'select', 'secret']);
export type ConfigFieldType = z.infer<typeof ConfigFieldTypeSchema>;

export const ConfigFieldSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: z.string().min(1),
  description: z.string().optional(),
  type: ConfigFieldTypeSchema,
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional().default(false),
  autoGenerate: z.boolean().optional().default(false),
});
export type ConfigField = z.infer<typeof ConfigFieldSchema>;

export const GameResourcesSchema = z.object({
  minRamGb: z.number().positive(),
  recommendedRamGb: z.number().positive(),
  minDiskGb: z.number().positive(),
});
export type GameResources = z.infer<typeof GameResourcesSchema>;

export const GameTemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  shortName: z.string().min(1).max(24),
  group: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  groupName: z.string().min(1).optional(),
  groupDescription: z.string().min(1).optional(),
  variantLabel: z.string().min(1).optional(),
  variantDescription: z.string().min(1).optional(),
  variantOrder: z.number().int().optional(),
  category: z.enum(['sandbox', 'automation', 'survival', 'factory', 'fps', 'rpg', 'other']).default('other'),
  description: z.string().min(1),
  accentColor: z.string().optional(),
  joinHint: z.string().optional(),
  resources: GameResourcesSchema,
  ports: z.array(PortSpecSchema).min(1),
  runtimes: z
    .object({
      preferred: RuntimeKindSchema,
      docker: DockerRuntimeSpecSchema.optional(),
      native: NativeRuntimeSpecSchema.optional(),
    })
    .refine((r) => Boolean(r.docker || r.native), {
      message: 'At least one runtime (docker or native) must be configured',
    }),
  query: QuerySpecSchema.default({ protocol: 'none' }),
  lifecycle: LifecycleSpecSchema.default({
    bootGraceSeconds: 180,
    gracefulStopTimeoutSeconds: 60,
    saveMethod: 'none',
  }),
  configFields: z.array(ConfigFieldSchema).default([]),
  isCustom: z.boolean().optional().default(false),
});

export type GameTemplate = z.infer<typeof GameTemplateSchema>;

export interface CatalogDeployTile {
  key: string;
  name: string;
  description: string;
  category: GameTemplate['category'];
  isCustom: boolean;
  minRamGb: number;
  hasNative: boolean;
  variants: GameTemplate[];
}

/**
 * Consolidates catalog templates that declare the same `group` into a single
 * deploy tile while leaving standalone templates as single-variant tiles.
 */
export function groupCatalogTemplates(catalog: GameTemplate[]): CatalogDeployTile[] {
  const buckets = new Map<string, GameTemplate[]>();
  const order: string[] = [];

  for (const tpl of catalog) {
    const key = tpl.group?.trim() || tpl.id;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
      order.push(key);
    }
    list.push(tpl);
  }

  return order.map((key) => {
    const variants = [...(buckets.get(key) ?? [])].sort((a, b) => {
      const orderDiff = (a.variantOrder ?? 999) - (b.variantOrder ?? 999);
      return orderDiff !== 0 ? orderDiff : a.name.localeCompare(b.name);
    });
    const primary = variants[0];
    const groupName = variants.find((v) => v.groupName)?.groupName ?? primary.name;
    const groupDescription = variants.find((v) => v.groupDescription)?.groupDescription ?? primary.description;
    return {
      key,
      name: groupName,
      description: groupDescription,
      category: primary.category,
      isCustom: variants.every((v) => Boolean(v.isCustom)),
      minRamGb: Math.min(...variants.map((v) => v.resources.minRamGb)),
      hasNative: variants.some((v) => Boolean(v.runtimes.native)),
      variants,
    };
  });
}
