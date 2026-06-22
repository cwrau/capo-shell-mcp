import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createCacheStore, clusterListKey, kubeconfigKey } from './cache.js';
import {
  getContexts,
  listClustersForContext,
  fetchWorkloadKubeconfig,
  applyKubeconfigTransform,
  fetchOpenStackEnv,
  fetchApiServerInfo,
} from './k8s.js';
import { execWithKubeconfig } from './exec.js';
import { ensureProxy, refreshProxy } from './proxy.js';
import type { AppConfig, ManagementClusterConfig } from './config.js';
import type { CacheStore } from './cache.js';

function findMgmt(config: AppConfig, name: string): ManagementClusterConfig | undefined {
  return config.management_clusters.find((m) => m.name === name);
}

async function resolveContexts(mgmt: ManagementClusterConfig): Promise<string[]> {
  return mgmt.context ? [mgmt.context] : getContexts(mgmt.kubeconfig);
}

async function cachedKubeconfig(
  cache: CacheStore,
  config: AppConfig,
  mgmt: ManagementClusterConfig,
  context: string,
  namespace: string,
  clusterName: string,
  ttlSeconds: number,
): Promise<string> {
  const sshuttleHost = mgmt.sshuttle_host ?? config.sshuttle_host;
  const key = kubeconfigKey(mgmt.name, context, namespace, clusterName);
  const cached = cache.kubeconfig.get(key);

  if (cached) {
    if (sshuttleHost) refreshProxy(key, ttlSeconds);
    return cached;
  }

  let kc = await fetchWorkloadKubeconfig(mgmt, context, namespace, clusterName);
  if (config.transforms) {
    kc = await applyKubeconfigTransform(kc, config.transforms);
  }
  cache.kubeconfig.set(key, kc);

  if (sshuttleHost) {
    const apiIp = await fetchApiServerInfo(mgmt, context, namespace, clusterName);
    if (apiIp) {
      await ensureProxy(key, sshuttleHost, apiIp, ttlSeconds);
    }
  }

  return kc;
}

export function buildServer(): McpServer {
  const config = loadConfig();
  const cache = createCacheStore(config.cache);
  const server = new McpServer({ name: 'capo-shell-mcp', version: '0.1.0' });

  server.tool(
    'list_clusters',
    'List all CAPO workload clusters across configured management clusters. Results cached per management-cluster+context.',
    {
      management_cluster: z.string().optional().describe(
        'Filter to one management cluster by name. Omit to list all.',
      ),
    },
    async ({ management_cluster }) => {
      const targets = management_cluster
        ? config.management_clusters.filter((m) => m.name === management_cluster)
        : config.management_clusters;

      if (management_cluster && targets.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `Unknown management cluster: ${management_cluster}` }],
          isError: true,
        };
      }

      const allClusters = (
        await Promise.all(
          targets.map(async (mgmt) => {
            const contexts = await resolveContexts(mgmt);
            return Promise.all(
              contexts.map(async (ctx) => {
                const key = clusterListKey(mgmt.name, ctx);
                const cached = cache.clusterList.get(key);
                if (cached) return cached;
                const result = await listClustersForContext(mgmt, ctx, config.custom_fields);
                cache.clusterList.set(key, result);
                return result;
              }),
            );
          }),
        )
      ).flat(2);

      return { content: [{ type: 'text' as const, text: JSON.stringify(allClusters, null, 2) }] };
    },
  );

  server.tool(
    'get_cluster_kubeconfig',
    'Return the (transformed) kubeconfig YAML for a CAPO workload cluster. Result is cached. Starts sshuttle proxy if configured.',
    {
      management_cluster: z.string().describe('Management cluster name (from config).'),
      context: z.string().describe('kubectl context within the management cluster kubeconfig.'),
      namespace: z.string().describe('Namespace of the workload cluster.'),
      cluster_name: z.string().describe('Workload cluster name (Cluster CR name).'),
    },
    async ({ management_cluster, context, namespace, cluster_name }) => {
      const mgmt = findMgmt(config, management_cluster);
      if (!mgmt) {
        return {
          content: [{ type: 'text' as const, text: `Unknown management cluster: ${management_cluster}` }],
          isError: true,
        };
      }
      const kc = await cachedKubeconfig(
        cache, config, mgmt, context, namespace, cluster_name, config.cache.kubeconfig_ttl,
      );
      return { content: [{ type: 'text' as const, text: kc }] };
    },
  );

  server.tool(
    'exec_in_cluster',
    'Run a command with the workload cluster KUBECONFIG and OpenStack credentials set as env vars. Kubeconfig is cached and sshuttle proxy is managed automatically. OS credentials are fetched fresh each call.',
    {
      management_cluster: z.string().describe('Management cluster name (from config).'),
      context: z.string().describe('kubectl context within the management cluster kubeconfig.'),
      namespace: z.string().describe('Namespace of the workload cluster.'),
      cluster_name: z.string().describe('Workload cluster name (Cluster CR name).'),
      command: z.array(z.string()).min(1).describe('Command + args to run, e.g. ["kubectl","get","nodes"].'),
    },
    async ({ management_cluster, context, namespace, cluster_name, command }) => {
      const mgmt = findMgmt(config, management_cluster);
      if (!mgmt) {
        return {
          content: [{ type: 'text' as const, text: `Unknown management cluster: ${management_cluster}` }],
          isError: true,
        };
      }

      const [kc, osEnv] = await Promise.all([
        cachedKubeconfig(cache, config, mgmt, context, namespace, cluster_name, config.cache.kubeconfig_ttl),
        fetchOpenStackEnv(mgmt, context, namespace, cluster_name),
      ]);

      const result = await execWithKubeconfig(kc, osEnv, command);

      const parts = [
        result.stdout && `STDOUT:\n${result.stdout}`,
        result.stderr && `STDERR:\n${result.stderr}`,
        `EXIT CODE: ${result.exitCode}`,
      ].filter(Boolean);

      return {
        content: [{ type: 'text' as const, text: parts.join('\n\n') }],
        isError: result.exitCode !== 0,
      };
    },
  );

  return server;
}
