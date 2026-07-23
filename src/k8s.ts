import { load, dump } from 'js-yaml';
import * as k8s from '@kubernetes/client-node';
import { shell } from './shell.js';
import type { KubeconfigTransforms, ManagementClusterConfig } from './config.js';

export interface CAPOCluster {
  management_cluster: string;
  context: string;
  namespace: string;
  name: string;
  custom_fields?: Record<string, string>;
}

const CLUSTER_GROUP = 'cluster.x-k8s.io';
const CLUSTER_VERSION = 'v1beta1';
const CLUSTER_PLURAL = 'clusters';
const OPENSTACKCLUSTER_GROUP = 'infrastructure.cluster.x-k8s.io';
const OPENSTACKCLUSTER_VERSION = 'v1beta1';
const OPENSTACKCLUSTER_PLURAL = 'openstackclusters';

function kubeConfigFromFile(kubeconfigPath: string, context?: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromFile(kubeconfigPath);
  if (context) kc.setCurrentContext(context);
  return kc;
}

function kubeConfigFromYaml(kcYaml: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  kc.loadFromString(kcYaml);
  return kc;
}

export async function getContexts(kubeconfig: string): Promise<string[]> {
  return kubeConfigFromFile(kubeconfig).getContexts().map((c) => c.name);
}

export async function listClustersForContext(
  mgmt: ManagementClusterConfig,
  context: string,
  customFields?: Record<string, string>,
): Promise<CAPOCluster[]> {
  const api = kubeConfigFromFile(mgmt.kubeconfig, context).makeApiClient(k8s.CustomObjectsApi);
  const result = await api.listCustomObjectForAllNamespaces({
    group: CLUSTER_GROUP,
    version: CLUSTER_VERSION,
    plural: CLUSTER_PLURAL,
  }) as { items: Array<{ metadata: { name: string; namespace: string } }> };

  const clusters: CAPOCluster[] = result.items.map((item) => ({
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
    { input: JSON.stringify(result) },
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
  const api = kubeConfigFromFile(mgmt.kubeconfig, context).makeApiClient(k8s.CoreV1Api);
  const secret = await api.readNamespacedSecret({ name: `${clusterName}-kubeconfig`, namespace });
  const value = secret.data?.value;
  if (!value) throw new Error(`fetchWorkloadKubeconfig: secret '${clusterName}-kubeconfig' has no 'value' key`);
  return Buffer.from(value, 'base64').toString('utf8');
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

async function fetchOpenStackCluster(
  mgmt: ManagementClusterConfig,
  context: string,
  namespace: string,
  clusterName: string,
): Promise<{
  spec: {
    identityRef?: { name: string };
    cloudName?: string;
    apiServerLoadBalancer?: { allowedCIDRs?: string[] };
    controlPlaneEndpoint?: { host: string; port: string };
  };
} | undefined> {
  const api = kubeConfigFromFile(mgmt.kubeconfig, context).makeApiClient(k8s.CustomObjectsApi);
  const result = await api.listNamespacedCustomObject({
    group: OPENSTACKCLUSTER_GROUP,
    version: OPENSTACKCLUSTER_VERSION,
    namespace,
    plural: OPENSTACKCLUSTER_PLURAL,
    labelSelector: `cluster.x-k8s.io/cluster-name=${clusterName}`,
  }) as {
    items: Array<{
      spec: {
        identityRef?: { name: string };
        cloudName?: string;
        apiServerLoadBalancer?: { allowedCIDRs?: string[] };
        controlPlaneEndpoint?: { host: string; port: string };
      };
    }>;
  };
  return result.items[0];
}

export async function fetchOpenStackEnv(
  mgmt: ManagementClusterConfig,
  context: string,
  namespace: string,
  clusterName: string,
): Promise<Record<string, string>> {
  const osc = await fetchOpenStackCluster(mgmt, context, namespace, clusterName);
  if (!osc) throw new Error(`No OpenStackCluster found for cluster '${clusterName}' in namespace '${namespace}'`);

  const secretName = osc.spec.identityRef?.name ?? `${clusterName}-cloud-config`;
  const cloudName = osc.spec.cloudName ?? 'openstack';

  const coreApi = kubeConfigFromFile(mgmt.kubeconfig, context).makeApiClient(k8s.CoreV1Api);
  const secret = await coreApi.readNamespacedSecret({ name: secretName, namespace });
  const cloudsB64 = secret.data?.['clouds.yaml'];
  if (!cloudsB64) throw new Error(`Secret '${secretName}' has no 'clouds.yaml' key`);
  const cloudsYaml = Buffer.from(cloudsB64, 'base64').toString('utf8');
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
  const osc = await fetchOpenStackCluster(mgmt, context, namespace, clusterName);
  if (!osc || !osc.spec.apiServerLoadBalancer?.allowedCIDRs?.length) return null;
  const apiHost = osc.spec.controlPlaneEndpoint?.host;
  const apiPort = osc.spec.controlPlaneEndpoint?.port;
  if (apiHost && apiPort) return [apiHost, apiPort];
  return null;
}

const READONLY_SA_NAME = 'capo-shell-mcp-read-only';
const READONLY_NAMESPACE = 'kube-system';

const READONLY_CLUSTER_ROLE: k8s.V1ClusterRole = {
  metadata: { name: READONLY_SA_NAME },
  rules: [
    { apiGroups: ['*'], resources: ['*'], verbs: ['get', 'list', 'watch'] },
    { nonResourceURLs: ['*'], verbs: ['get'] },
  ],
};

const READONLY_CLUSTER_ROLE_BINDING: k8s.V1ClusterRoleBinding = {
  metadata: { name: READONLY_SA_NAME },
  roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: READONLY_SA_NAME },
  subjects: [{ kind: 'ServiceAccount', name: READONLY_SA_NAME, namespace: READONLY_NAMESPACE }],
};

function isConflict(err: unknown): boolean {
  return err instanceof k8s.ApiException && err.code === 409;
}

function isImmutableRoleRefError(err: unknown): boolean {
  if (!(err instanceof k8s.ApiException)) return false;
  const message = (err.body as { message?: string } | undefined)?.message ?? err.message;
  return err.code === 422 && message.includes('roleRef') && message.includes('immutable');
}

async function ensureReadOnlyRbac(kc: k8s.KubeConfig): Promise<void> {
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);

  try {
    await coreApi.createNamespacedServiceAccount({
      namespace: READONLY_NAMESPACE,
      body: { metadata: { name: READONLY_SA_NAME, namespace: READONLY_NAMESPACE } },
    });
  } catch (err) {
    if (!isConflict(err)) throw err;
  }

  try {
    await rbacApi.createClusterRole({ body: READONLY_CLUSTER_ROLE });
  } catch (err) {
    if (!isConflict(err)) throw err;
    await rbacApi.replaceClusterRole({ name: READONLY_SA_NAME, body: READONLY_CLUSTER_ROLE });
  }

  try {
    await rbacApi.createClusterRoleBinding({ body: READONLY_CLUSTER_ROLE_BINDING });
    return;
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
  try {
    await rbacApi.replaceClusterRoleBinding({ name: READONLY_SA_NAME, body: READONLY_CLUSTER_ROLE_BINDING });
  } catch (err) {
    // roleRef is immutable — if it changed since the CRB was created, force a delete+recreate
    if (!isImmutableRoleRefError(err)) throw err;
    await rbacApi.deleteClusterRoleBinding({ name: READONLY_SA_NAME });
    await rbacApi.createClusterRoleBinding({ body: READONLY_CLUSTER_ROLE_BINDING });
  }
}

export async function createReadOnlyKubeconfig(
  adminKcYaml: string,
  durationSeconds: number,
): Promise<string> {
  const parsed = load(adminKcYaml) as {
    clusters: Array<{ cluster: { server: string; 'certificate-authority-data': string } }>;
  };
  const clusterInfo = parsed.clusters[0]?.cluster;
  if (!clusterInfo) throw new Error('createReadOnlyKubeconfig: no cluster found in admin kubeconfig');

  const kc = kubeConfigFromYaml(adminKcYaml);
  await ensureReadOnlyRbac(kc);

  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const tokenReq = await coreApi.createNamespacedServiceAccountToken({
    name: READONLY_SA_NAME,
    namespace: READONLY_NAMESPACE,
    body: { spec: { audiences: [], expirationSeconds: durationSeconds } },
  });
  const token = tokenReq.status?.token;
  if (!token) throw new Error('createReadOnlyKubeconfig: token request returned no token');

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
}
