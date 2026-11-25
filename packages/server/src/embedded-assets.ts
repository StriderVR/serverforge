/**
 * In development / standard Node mode, assets are loaded from disk
 * (catalog/games/*.yaml and packages/web/dist).
 *
 * When building the standalone ServerForge.exe bundle via scripts/build-exe-bundle.mjs,
 * esbuild replaces this module with the compiled React web assets, built-in YAML
 * game templates, and .env.example so ServerForge.exe runs as a single self-contained file.
 */

export interface EmbeddedAsset {
  contentBase64: string;
  mimeType: string;
}

export const IS_BUNDLED_EXE = false;

export const EMBEDDED_WEB_ASSETS: Record<string, EmbeddedAsset> = {};

export const EMBEDDED_CATALOG_FILES: Record<string, string> = {};

export const EMBEDDED_ENV_EXAMPLE = '';
