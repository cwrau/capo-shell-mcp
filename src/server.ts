import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig, ManagementClusterConfig } from './config.js';
import { loadConfig } from './config.js';
import type { CacheStore } from './cache.js';
import { clusterListKey, createCacheStore, kubeconfigKey } from './cache.js';
import type { CAPOCluster } from './k8s.js';
import {
  applyKubeconfigTransform,
  createReadOnlyKubeconfig,
  fetchApiServerInfo,
  fetchOpenStackEnv,
  fetchWorkloadKubeconfig,
  getContexts,
  listClustersForContext,
} from './k8s.js';
import { execWithKubeconfig } from './exec.js';
import { ensureProxy, refreshProxy } from './proxy.js';

function findMgmt(config: AppConfig, name: string): ManagementClusterConfig | undefined {
  return config.management_clusters.find((m) => m.name === name);
}

type ClusterWithMgmt = { cluster: CAPOCluster; mgmt: ManagementClusterConfig };

async function resolveAllClusters(
  config: AppConfig,
  cache: CacheStore,
  managementCluster: string | undefined,
): Promise<ClusterWithMgmt[] | null> {
  const targets = managementCluster
    ? config.management_clusters.filter((m) => m.name === managementCluster)
    : config.management_clusters;
  if (managementCluster && targets.length === 0) return null;

  const nested = await Promise.all(
    targets.map(async (mgmt) => {
      const contexts = await resolveContexts(mgmt);
      const perContext = await Promise.all(
        contexts.map(async (ctx) => {
          const key = clusterListKey(mgmt.name, ctx);
          const cached = cache.clusterList.get(key);
          if (cached) return cached;
          const result = await listClustersForContext(mgmt, ctx, config.custom_fields);
          cache.clusterList.set(key, result);
          return result;
        }),
      );
      return perContext.flat().map((cluster): ClusterWithMgmt => ({ cluster, mgmt }));
    }),
  );
  return nested.flat();
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
    const apiServerInfo = await fetchApiServerInfo(mgmt, context, namespace, clusterName);
    if (apiServerInfo) {
      const [apiIp, apiPort] = apiServerInfo;
      await ensureProxy(key, sshuttleHost, apiIp, apiPort, ttlSeconds);
    }
  }

  return kc;
}

export function buildServer(): McpServer {
  const config = loadConfig();
  const cache = createCacheStore(config.cache);
  const server = new McpServer(
    { name: 'capo-shell-mcp', version: '0.1.0' },
    {
      instructions:
        'Use list_clusters to discover clusters before calling any other tool — it returns the management_cluster/context/namespace/cluster_name tuple required by all other tools.\n\n' +
        'Management clusters are themselves valid cluster targets. They appear as regular entries in list_clusters results and can be targeted with exec_in_cluster(_readonly) exactly like any workload cluster. Do not assume management clusters are unavailable or unreachable as targets.\n\n' +
        'Default to exec_in_cluster_readonly for read/check/status/debug tasks. Only use exec_in_cluster when a write, OpenStack credentials, or a privileged pod (e.g. kubectl debug node) is needed.',
    },
  );

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
      stdin: z.string().optional().describe('Data to pipe to the command\'s stdin, e.g. YAML for "kubectl apply -f -".'),
    },
    async ({ management_cluster, context, namespace, cluster_name, command, stdin }) => {
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

      const result = await execWithKubeconfig(kc, osEnv, command, stdin);

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

  server.tool(
    'get_cluster_kubeconfig_readonly',
    'Return a read-only kubeconfig for a CAPO workload cluster using the TokenRequest API. Always applies ServiceAccount capo-shell-mcp-read-only (bound to ClusterRole/view) to the workload cluster. Token lifetime matches kubeconfig_ttl.',
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
      const adminKc = await cachedKubeconfig(
        cache, config, mgmt, context, namespace, cluster_name, config.cache.kubeconfig_ttl,
      );
      const roKc = await createReadOnlyKubeconfig(adminKc, config.cache.kubeconfig_ttl);
      return { content: [{ type: 'text' as const, text: roKc }] };
    },
  );

  server.tool(
    'exec_in_cluster_readonly',
    'Run a command with a read-only kubeconfig for the workload cluster. Always applies ServiceAccount capo-shell-mcp-read-only (bound to ClusterRole/view) via TokenRequest API. No OpenStack credentials are injected.',
    {
      management_cluster: z.string().describe('Management cluster name (from config).'),
      context: z.string().describe('kubectl context within the management cluster kubeconfig.'),
      namespace: z.string().describe('Namespace of the workload cluster.'),
      cluster_name: z.string().describe('Workload cluster name (Cluster CR name).'),
      command: z.array(z.string()).min(1).describe('Command + args to run, e.g. ["kubectl","get","nodes"].'),
      stdin: z.string().optional().describe('Data to pipe to the command\'s stdin, e.g. YAML for "kubectl apply -f -".'),
    },
    async ({ management_cluster, context, namespace, cluster_name, command, stdin }) => {
      const mgmt = findMgmt(config, management_cluster);
      if (!mgmt) {
        return {
          content: [{ type: 'text' as const, text: `Unknown management cluster: ${management_cluster}` }],
          isError: true,
        };
      }
      const adminKc = await cachedKubeconfig(
        cache, config, mgmt, context, namespace, cluster_name, config.cache.kubeconfig_ttl,
      );
      const roKc = await createReadOnlyKubeconfig(adminKc, config.cache.kubeconfig_ttl);
      const result = await execWithKubeconfig(roKc, {}, command, stdin);
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

  server.tool(
    'exec_in_clusters',
    'Run a command in parallel across multiple or all CAPO workload clusters. Returns per-cluster results. Kubeconfig is cached; OS credentials are fetched fresh per cluster.',
    {
      management_cluster: z.string().optional().describe('Filter to one management cluster by name. Omit to target all.'),
      command: z.array(z.string()).min(1).describe('Command + args to run, e.g. ["kubectl","get","nodes"].'),
      stdin: z.string().optional().describe('Data to pipe to stdin for each invocation.'),
    },
    async ({ management_cluster, command, stdin }) => {
      const targets = await resolveAllClusters(config, cache, management_cluster);
      if (targets === null) {
        return {
          content: [{ type: 'text' as const, text: `Unknown management cluster: ${management_cluster}` }],
          isError: true,
        };
      }

      const results = await Promise.all(
        targets.map(async ({ cluster, mgmt }) => {
          const id = { management_cluster: cluster.management_cluster, context: cluster.context, namespace: cluster.namespace, name: cluster.name };
          try {
            const [kc, osEnv] = await Promise.all([
              cachedKubeconfig(cache, config, mgmt, cluster.context, cluster.namespace, cluster.name, config.cache.kubeconfig_ttl),
              fetchOpenStackEnv(mgmt, cluster.context, cluster.namespace, cluster.name),
            ]);
            const r = await execWithKubeconfig(kc, osEnv, command, stdin);
            return { cluster: id, stdout: r.stdout || null, stderr: r.stderr || null, exit_code: r.exitCode, error: null };
          } catch (err) {
            return { cluster: id, stdout: null, stderr: null, exit_code: null, error: String(err) };
          }
        }),
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        isError: results.some((r) => r.exit_code !== 0 || r.error !== null),
      };
    },
  );

  server.tool(
    'exec_in_clusters_readonly',
    'Run a command in parallel across multiple or all CAPO workload clusters using read-only kubeconfigs. No OpenStack credentials injected.',
    {
      management_cluster: z.string().optional().describe('Filter to one management cluster by name. Omit to target all.'),
      command: z.array(z.string()).min(1).describe('Command + args to run, e.g. ["kubectl","get","nodes"].'),
      stdin: z.string().optional().describe('Data to pipe to stdin for each invocation.'),
    },
    async ({ management_cluster, command, stdin }) => {
      const targets = await resolveAllClusters(config, cache, management_cluster);
      if (targets === null) {
        return {
          content: [{ type: 'text' as const, text: `Unknown management cluster: ${management_cluster}` }],
          isError: true,
        };
      }

      const results = await Promise.all(
        targets.map(async ({ cluster, mgmt }) => {
          const id = { management_cluster: cluster.management_cluster, context: cluster.context, namespace: cluster.namespace, name: cluster.name };
          try {
            const adminKc = await cachedKubeconfig(cache, config, mgmt, cluster.context, cluster.namespace, cluster.name, config.cache.kubeconfig_ttl);
            const roKc = await createReadOnlyKubeconfig(adminKc, config.cache.kubeconfig_ttl);
            const r = await execWithKubeconfig(roKc, {}, command, stdin);
            return { cluster: id, stdout: r.stdout || null, stderr: r.stderr || null, exit_code: r.exitCode, error: null };
          } catch (err) {
            return { cluster: id, stdout: null, stderr: null, exit_code: null, error: String(err) };
          }
        }),
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        isError: results.some((r) => r.exit_code !== 0 || r.error !== null),
      };
    },
  );

  return server;
}
