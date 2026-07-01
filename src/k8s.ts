import { load, dump } from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { shell } from './shell.js';
import type { KubeconfigTransforms, ManagementClusterConfig } from './config.js';

export interface CAPOCluster {
  management_cluster: string;
  context: string;
  namespace: string;
  name: string;
  custom_fields?: Record<string, string>;
}

function withContext(context?: string): string[] {
  return context ? ['--context', context] : [];
}

function kubectlEnv(kubeconfig: string): NodeJS.ProcessEnv {
  return { ...process.env, KUBECONFIG: kubeconfig };
}

export async function getContexts(kubeconfig: string): Promise<string[]> {
  const { stdout } = await shell.execFile(
    'kubectl',
    ['config', 'get-contexts', '-o', 'name'],
    { env: kubectlEnv(kubeconfig) },
  );
  return stdout.trim().split('\n').filter(Boolean);
}

export async function listClustersForContext(
  mgmt: ManagementClusterConfig,
  context: string,
  customFields?: Record<string, string>,
): Promise<CAPOCluster[]> {
  const { stdout } = await shell.execFile(
    'kubectl',
    [...withContext(context), 'get', 'cluster', '-A', '-o', 'json'],
    { env: kubectlEnv(mgmt.kubeconfig) },
  );
  const parsed = JSON.parse(stdout) as { items: Array<{ metadata: { name: string; namespace: string } }> };

  const clusters: CAPOCluster[] = parsed.items.map((item) => ({
    management_cluster: mgmt.name,
    context,
    namespace: item.metadata.namespace,
    name: item.metadata.name,
  }));

  if (clusters.length === 0 || !customFields) return clusters;

  const fieldExprs = Object.entries(customFields)
    .map(([k, expr]) => `${JSON.stringify(k)}: (${expr})`)
    .join(', ');
  const { stdout: jqOut } = await shell.execFile(
    'jq',
    [`[.items[] | {${fieldExprs}}]`],
    { input: stdout },
  );
  const fieldValues = JSON.parse(jqOut) as Array<Record<string, string | null>>;

  for (let i = 0; i < clusters.length; i++) {
    const cf: Record<string, string> = {};
    for (const [k, v] of Object.entries(fieldValues[i] ?? {})) {
      if (v != null && v !== '') cf[k] = v;
    }
    if (Object.keys(cf).length > 0) clusters[i].custom_fields = cf;
  }

  return clusters;
}

export async function fetchWorkloadKubeconfig(
  mgmt: ManagementClusterConfig,
  context: string,
  namespace: string,
  clusterName: string,
): Promise<string> {
  const { stdout } = await shell.execFile(
    'kubectl',
    [
      ...withContext(context),
      '-n', namespace,
      'get', 'secret', `${clusterName}-kubeconfig`,
      '-o', 'jsonpath={.data.value}',
    ],
    { env: kubectlEnv(mgmt.kubeconfig) },
  );
  return Buffer.from(stdout.trim(), 'base64').toString('utf8');
}

export async function applyKubeconfigTransform(kcYaml: string, transforms: KubeconfigTransforms): Promise<string> {
  const parts: string[] = [];
  if (transforms.clusters) parts.push(`.clusters |= map(${transforms.clusters})`);
  if (transforms.contexts) parts.push(`.contexts |= map(${transforms.contexts})`);
  if (transforms.users) parts.push(`.users |= map(${transforms.users})`);
  const input = JSON.stringify(load(kcYaml));
  const { stdout } = await shell.execFile('jq', [parts.join(' | ')], { input });
  return dump(JSON.parse(stdout));
}

export async function fetchOpenStackEnv(
  mgmt: ManagementClusterConfig,
  context: string,
  namespace: string,
  clusterName: string,
): Promise<Record<string, string>> {
  const { stdout: oscOut } = await shell.execFile(
    'kubectl',
    [
      ...withContext(context),
      '-n', namespace,
      'get', 'openstackcluster',
      '-l', `cluster.x-k8s.io/cluster-name=${clusterName}`,
      '-o', 'json',
    ],
    { env: kubectlEnv(mgmt.kubeconfig) },
  );
  const oscList = JSON.parse(oscOut) as {
    items: Array<{ spec: { identityRef?: { name: string }; cloudName?: string } }>;
  };
  const osc = oscList.items[0];
  if (!osc) throw new Error(`No OpenStackCluster found for cluster '${clusterName}' in namespace '${namespace}'`);

  const secretName = osc.spec.identityRef?.name ?? `${clusterName}-cloud-config`;
  const cloudName = osc.spec.cloudName ?? 'openstack';

  const { stdout: secretOut } = await shell.execFile(
    'kubectl',
    [
      ...withContext(context),
      '-n', namespace,
      'get', 'secret', secretName,
      '-o', 'jsonpath={.data.clouds\\.yaml}',
    ],
    { env: kubectlEnv(mgmt.kubeconfig) },
  );
  const cloudsYaml = Buffer.from(secretOut.trim(), 'base64').toString('utf8');
  const clouds = load(cloudsYaml) as {
    clouds: Record<string, {
      auth: Record<string, string>;
      region_name?: string;
      cacert?: string;
      auth_type?: string;
      interface?: string;
      identity_api_version?: string;
    }>;
  };
  const cloud = clouds.clouds[cloudName];
  if (!cloud) throw new Error(`OpenStack cloud '${cloudName}' not found in clouds.yaml`);

  const raw: Record<string, string | undefined> = {
    OS_AUTH_URL: cloud.auth.auth_url,
    OS_USERNAME: cloud.auth.username,
    OS_PASSWORD: cloud.auth.password,
    OS_PROJECT_NAME: cloud.auth.project_name,
    OS_USER_DOMAIN_NAME: cloud.auth.user_domain_name,
    OS_PROJECT_DOMAIN_NAME: cloud.auth.project_domain_name,
    OS_REGION_NAME: cloud.region_name,
    OS_CACERT: cloud.cacert,
    OS_APPLICATION_CREDENTIAL_ID: cloud.auth.application_credential_id,
    OS_APPLICATION_CREDENTIAL_SECRET: cloud.auth.application_credential_secret,
    OS_AUTH_TYPE: cloud.auth_type ?? cloud.auth.auth_type,
    OS_INTERFACE: cloud.interface,
    OS_IDENTITY_API_VERSION: cloud.identity_api_version,
  };

  return Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
}

// Returns [host, port] if the cluster has restricted allowedCIDRs, null otherwise.
export async function fetchApiServerInfo(
  mgmt: ManagementClusterConfig,
  context: string,
  namespace: string,
  clusterName: string,
): Promise<[string, string] | null> {
  const { stdout } = await shell.execFile(
    'kubectl',
    [
      ...withContext(context),
      '-n', namespace,
      'get', 'openstackcluster',
      '-l', `cluster.x-k8s.io/cluster-name=${clusterName}`,
      '-o', 'json',
    ],
    { env: kubectlEnv(mgmt.kubeconfig) },
  );
  const parsed = JSON.parse(stdout) as {
    items: Array<{
      spec: {
        apiServerLoadBalancer?: { allowedCIDRs?: string[] };
        controlPlaneEndpoint?: { host: string; port: string };
      };
    }>;
  };
  const item = parsed.items[0];
  if (!item) return null;
  if (!item.spec.apiServerLoadBalancer?.allowedCIDRs?.length) return null;
  const apiHost = item.spec.controlPlaneEndpoint?.host;
  const apiPort = item.spec.controlPlaneEndpoint?.port;
  if (apiHost && apiPort) return [apiHost, apiPort];
  return null;
}

const READONLY_SA_NAME = 'capo-shell-mcp-read-only';
const READONLY_NAMESPACE = 'default';

const READONLY_MANIFEST = `\
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${READONLY_SA_NAME}
  namespace: ${READONLY_NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${READONLY_SA_NAME}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
- kind: ServiceAccount
  name: ${READONLY_SA_NAME}
  namespace: ${READONLY_NAMESPACE}
`;

export async function createReadOnlyKubeconfig(
  adminKcYaml: string,
  durationSeconds: number,
): Promise<string> {
  const parsed = load(adminKcYaml) as {
    clusters: Array<{ cluster: { server: string; 'certificate-authority-data': string } }>;
  };
  const clusterInfo = parsed.clusters[0]?.cluster;
  if (!clusterInfo) throw new Error('createReadOnlyKubeconfig: no cluster found in admin kubeconfig');

  const tmpFile = path.join(
    os.tmpdir(),
    `capo-shell-mcp-admin-${Math.random().toString(36).slice(2)}.yaml`,
  );
  await fs.writeFile(tmpFile, adminKcYaml, { mode: 0o600 });

  try {
    const env: NodeJS.ProcessEnv = { ...process.env, KUBECONFIG: tmpFile };

    await shell.execFile('kubectl', ['apply', '-f', '-'], { env, input: READONLY_MANIFEST });

    const { stdout: token } = await shell.execFile(
      'kubectl',
      ['create', 'token', READONLY_SA_NAME, '--namespace', READONLY_NAMESPACE, '--duration', `${durationSeconds}s`],
      { env },
    );

    return dump({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [{
        name: 'workload',
        cluster: {
          server: clusterInfo.server,
          'certificate-authority-data': clusterInfo['certificate-authority-data'],
        },
      }],
      contexts: [{
        name: 'readonly',
        context: { cluster: 'workload', user: READONLY_SA_NAME, namespace: READONLY_NAMESPACE },
      }],
      'current-context': 'readonly',
      users: [{
        name: READONLY_SA_NAME,
        user: { token: token.trim() },
      }],
    });
  } finally {
    await fs.unlink(tmpFile).catch(() => undefined);
  }
}
