import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';

export interface KubeconfigTransforms {
  clusters?: string;
  contexts?: string;
  users?: string;
}

export interface ManagementClusterConfig {
  name: string;
  kubeconfig: string;
  context?: string;
  sshuttle_host?: string;  // overrides AppConfig.sshuttle_host
}

export interface CacheConfig {
  cluster_list_ttl: number;
  kubeconfig_ttl: number;
}

export interface AppConfig {
  management_clusters: ManagementClusterConfig[];
  transforms?: KubeconfigTransforms;
  custom_fields?: Record<string, string>;
  sshuttle_host?: string;
  cache: CacheConfig;
}

const DEFAULTS: CacheConfig = { cluster_list_ttl: 300, kubeconfig_ttl: 3600 };

function configPath(): string {
  return process.env.CAPO_SHELL_MCP_CONFIG
    ?? path.join(os.homedir(), '.config', 'capo-shell', 'config.yaml');
}

function expandEnv(s: string): string {
  return s.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) =>
    process.env[braced ?? bare] ?? '',
  );
}

function parseTransforms(raw: unknown): KubeconfigTransforms | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: KubeconfigTransforms = {};
  if (typeof obj.clusters === 'string') result.clusters = obj.clusters;
  if (typeof obj.contexts === 'string') result.contexts = obj.contexts;
  if (typeof obj.users === 'string') result.users = obj.users;
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseCustomFields(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function loadConfig(): AppConfig {
  const raw = yaml.load(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

  if (!Array.isArray(raw?.management_clusters) || raw.management_clusters.length === 0) {
    throw new Error('config: management_clusters must be a non-empty array');
  }

  const management_clusters: ManagementClusterConfig[] = (raw.management_clusters as unknown[]).map(
    (c, i) => {
      if (typeof c !== 'object' || c === null)
        throw new Error(`config: management_clusters[${i}] must be an object`);
      const obj = c as Record<string, unknown>;
      if (typeof obj.name !== 'string')
        throw new Error(`config: management_clusters[${i}].name must be a string`);
      if (typeof obj.kubeconfig !== 'string')
        throw new Error(`config: management_clusters[${i}].kubeconfig must be a string`);
      return {
        name: obj.name,
        kubeconfig: expandEnv(obj.kubeconfig),
        context: typeof obj.context === 'string' ? obj.context : undefined,
        sshuttle_host: typeof obj.sshuttle_host === 'string' ? expandEnv(obj.sshuttle_host) : undefined,
      };
    },
  );

  const rawCache = ((raw.cache ?? {}) as Partial<CacheConfig>);
  const cache: CacheConfig = {
    cluster_list_ttl: rawCache.cluster_list_ttl ?? DEFAULTS.cluster_list_ttl,
    kubeconfig_ttl: rawCache.kubeconfig_ttl ?? DEFAULTS.kubeconfig_ttl,
  };

  return {
    management_clusters,
    transforms: parseTransforms(raw.transforms),
    custom_fields: parseCustomFields(raw.custom_fields),
    sshuttle_host: typeof raw.sshuttle_host === 'string' ? expandEnv(raw.sshuttle_host) : undefined,
    cache,
  };
}
