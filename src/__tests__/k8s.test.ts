import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const stubs = vi.hoisted(() => ({
  contexts: [] as string[],
  coreV1: {} as Record<string, ReturnType<typeof vi.fn>>,
  customObjects: {} as Record<string, ReturnType<typeof vi.fn>>,
  rbac: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@kubernetes/client-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kubernetes/client-node')>();

  class FakeKubeConfig {
    loadFromFile(_path: string) {}
    loadFromString(_yaml: string) {}
    setCurrentContext(_ctx: string) {}
    getContexts() {
      return stubs.contexts.map((name) => ({ name }));
    }
    makeApiClient(apiClientType: unknown) {
      if (apiClientType === actual.CoreV1Api) return stubs.coreV1;
      if (apiClientType === actual.CustomObjectsApi) return stubs.customObjects;
      if (apiClientType === actual.RbacAuthorizationV1Api) return stubs.rbac;
      throw new Error('unexpected api client type in test');
    }
  }

  return { ...actual, KubeConfig: FakeKubeConfig };
});

const mgmt = { name: 'prod', kubeconfig: '/kube/prod.yaml', context: undefined };

beforeEach(() => {
  stubs.contexts = [];
  stubs.coreV1 = {};
  stubs.customObjects = {};
  stubs.rbac = {};
});

describe('getContexts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns list of context names', async () => {
    stubs.contexts = ['ctx-a', 'ctx-b'];
    const { getContexts } = await import('../k8s.js');
    const result = await getContexts('/kube/prod.yaml');
    expect(result).toEqual(['ctx-a', 'ctx-b']);
  });
});

describe('listClustersForContext', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses cluster list from the API response', async () => {
    const items = [
      { metadata: { name: 'cluster-1', namespace: 'ns-1' } },
      { metadata: { name: 'cluster-2', namespace: 'ns-2' } },
    ];
    stubs.customObjects.listCustomObjectForAllNamespaces = vi.fn().mockResolvedValue({ items });
    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(mgmt, 'ctx-a');
    expect(result).toEqual([
      { management_cluster: 'prod', context: 'ctx-a', namespace: 'ns-1', name: 'cluster-1' },
      { management_cluster: 'prod', context: 'ctx-a', namespace: 'ns-2', name: 'cluster-2' },
    ]);
    expect(stubs.customObjects.listCustomObjectForAllNamespaces).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'cluster.x-k8s.io', version: 'v1beta1', plural: 'clusters' }),
    );
  });

  it('returns empty array when no clusters', async () => {
    stubs.customObjects.listCustomObjectForAllNamespaces = vi.fn().mockResolvedValue({ items: [] });
    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(mgmt, 'ctx-a');
    expect(result).toEqual([]);
  });

  it('populates custom_fields from jq expressions', async () => {
    const items = [{ metadata: { name: 'cluster-1', namespace: 'ns-1' } }];
    stubs.customObjects.listCustomObjectForAllNamespaces = vi.fn().mockResolvedValue({ items });

    const { listClustersForContext } = await import('../k8s.js');
    const customFields = {
      friendly_name: '"My Cluster"',
      customer_name: '"acme"',
    };
    const result = await listClustersForContext(mgmt, 'ctx-a', customFields);
    expect(result[0].custom_fields).toEqual({ friendly_name: 'My Cluster', customer_name: 'acme' });
  });

  it('skips null/empty custom field values', async () => {
    const items = [{ metadata: { name: 'c', namespace: 'ns' } }];
    stubs.customObjects.listCustomObjectForAllNamespaces = vi.fn().mockResolvedValue({ items });

    const { listClustersForContext } = await import('../k8s.js');
    const customFields = { friendly_name: 'null', customer_name: '""' };
    const result = await listClustersForContext(mgmt, 'ctx-a', customFields);
    expect(result[0].custom_fields).toBeUndefined();
  });
});

describe('fetchWorkloadKubeconfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('base64-decodes the secret value', async () => {
    const rawKubeconfig = 'apiVersion: v1\nclusters: []';
    const encoded = Buffer.from(rawKubeconfig).toString('base64');
    stubs.coreV1.readNamespacedSecret = vi.fn().mockResolvedValue({ data: { value: encoded } });
    const { fetchWorkloadKubeconfig } = await import('../k8s.js');
    const result = await fetchWorkloadKubeconfig(mgmt, 'ctx-a', 'ns-1', 'cluster-1');
    expect(result).toBe(rawKubeconfig);
    expect(stubs.coreV1.readNamespacedSecret).toHaveBeenCalledWith({
      name: 'cluster-1-kubeconfig',
      namespace: 'ns-1',
    });
  });
});

describe('applyKubeconfigTransform', () => {
  // These tests call real jq — no mocking needed
  const input = `
clusters:
  - cluster:
      server: https://10.0.0.1:6443
      certificate-authority-data: abc123
    name: my-cluster
users:
  - name: admin
    user:
      client-certificate-data: cert123
      client-key-data: key456
`;

  it('overrides server URL via clusters transform', async () => {
    const { applyKubeconfigTransform } = await import('../k8s.js');
    const result = await applyKubeconfigTransform(
      input,
      { clusters: '.cluster.server = "https://custom.host:6443"' },
    );
    expect(result).toContain('https://custom.host:6443');
  });

  it('replaces user credentials with OIDC exec plugin via users transform', async () => {
    const { applyKubeconfigTransform } = await import('../k8s.js');
    const result = await applyKubeconfigTransform(input, {
      users: '{name: .name, user: {exec: {apiVersion: "client.authentication.k8s.io/v1beta1", command: "kubectl", args: ["oidc-login", "get-token"]}}}',
    });
    const parsed = (await import('js-yaml')).load(result) as {
      users: Array<{ name: string; user: { exec: { command: string; args: string[] } } }>;
    };
    expect(parsed.users[0].name).toBe('admin');
    expect(parsed.users[0].user.exec.command).toBe('kubectl');
    expect(result).not.toContain('client-certificate-data');
    expect(result).not.toContain('client-key-data');
  });

  it('identity transform preserves kubeconfig structure', async () => {
    const { applyKubeconfigTransform } = await import('../k8s.js');
    const result = await applyKubeconfigTransform(input, { clusters: '.' });
    const parsed = (await import('js-yaml')).load(result) as { clusters: unknown[] };
    expect(parsed.clusters).toHaveLength(1);
  });
});

describe('fetchOpenStackEnv', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses label selector and extracts OS env vars', async () => {
    stubs.customObjects.listNamespacedCustomObject = vi.fn().mockResolvedValue({
      items: [{ spec: { identityRef: { name: 'os-creds' }, cloudName: 'openstack' } }],
    });
    const cloudsYaml = `
clouds:
  openstack:
    auth:
      auth_url: https://keystone.example.com/v3
      application_credential_id: cred-id
      application_credential_secret: cred-secret
    region_name: RegionOne
`;
    const encoded = Buffer.from(cloudsYaml).toString('base64');
    stubs.coreV1.readNamespacedSecret = vi.fn().mockResolvedValue({ data: { 'clouds.yaml': encoded } });

    const { fetchOpenStackEnv } = await import('../k8s.js');
    const env = await fetchOpenStackEnv(mgmt, 'ctx-a', 'ns-1', 'cluster-1');

    expect(stubs.customObjects.listNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ labelSelector: 'cluster.x-k8s.io/cluster-name=cluster-1' }),
    );
    expect(stubs.coreV1.readNamespacedSecret).toHaveBeenCalledWith({ name: 'os-creds', namespace: 'ns-1' });

    expect(env.OS_AUTH_URL).toBe('https://keystone.example.com/v3');
    expect(env.OS_APPLICATION_CREDENTIAL_ID).toBe('cred-id');
    expect(env.OS_APPLICATION_CREDENTIAL_SECRET).toBe('cred-secret');
    expect(env.OS_REGION_NAME).toBe('RegionOne');
  });

  it('throws when no OpenStackCluster found', async () => {
    stubs.customObjects.listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const { fetchOpenStackEnv } = await import('../k8s.js');
    await expect(fetchOpenStackEnv(mgmt, 'ctx-a', 'ns-1', 'cluster-1'))
      .rejects.toThrow(/No OpenStackCluster found/);
  });
});

describe('fetchApiServerInfo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null when no items', async () => {
    stubs.customObjects.listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const { fetchApiServerInfo } = await import('../k8s.js');
    expect(await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1')).toBeNull();
  });

  it('returns null when no allowedCIDRs', async () => {
    stubs.customObjects.listNamespacedCustomObject = vi.fn().mockResolvedValue({
      items: [{ spec: { controlPlaneEndpoint: { host: '10.0.0.1' } } }],
    });
    const { fetchApiServerInfo } = await import('../k8s.js');
    expect(await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1')).toBeNull();
  });

  it('returns [host, port] when allowedCIDRs present', async () => {
    stubs.customObjects.listNamespacedCustomObject = vi.fn().mockResolvedValue({
      items: [{
        spec: {
          apiServerLoadBalancer: { allowedCIDRs: ['0.0.0.0/0'] },
          controlPlaneEndpoint: { host: '10.0.0.1', port: '6443' },
        },
      }],
    });
    const { fetchApiServerInfo } = await import('../k8s.js');
    expect(await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1')).toEqual(['10.0.0.1', '6443']);
  });

  it('uses label selector', async () => {
    stubs.customObjects.listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const { fetchApiServerInfo } = await import('../k8s.js');
    await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1');
    expect(stubs.customObjects.listNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ labelSelector: 'cluster.x-k8s.io/cluster-name=cluster-1' }),
    );
  });
});

describe('createReadOnlyKubeconfig', () => {
  const adminKcYaml = `\
apiVersion: v1
kind: Config
clusters:
- name: workload
  cluster:
    server: https://10.0.0.1:6443
    certificate-authority-data: dGVzdC1jYQ==
contexts:
- name: admin
  context:
    cluster: workload
    user: admin
current-context: admin
users:
- name: admin
  user:
    token: old-admin-token
`;

  function mockRbacHappyPath() {
    stubs.coreV1.createNamespacedServiceAccount = vi.fn().mockResolvedValue({});
    stubs.rbac.createClusterRole = vi.fn().mockResolvedValue({});
    stubs.rbac.createClusterRoleBinding = vi.fn().mockResolvedValue({});
    stubs.coreV1.createNamespacedServiceAccountToken = vi.fn().mockResolvedValue({
      status: { token: 'mytoken' },
    });
  }

  afterEach(() => vi.restoreAllMocks());

  it('creates SA, ClusterRole, ClusterRoleBinding, then a token', async () => {
    mockRbacHappyPath();

    const { createReadOnlyKubeconfig } = await import('../k8s.js');
    await createReadOnlyKubeconfig(adminKcYaml, 3600);

    expect(stubs.coreV1.createNamespacedServiceAccount).toHaveBeenCalledWith({
      namespace: 'kube-system',
      body: { metadata: { name: 'capo-shell-mcp-read-only', namespace: 'kube-system' } },
    });
    expect(stubs.rbac.createClusterRole).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ metadata: { name: 'capo-shell-mcp-read-only' } }) }),
    );
    expect(stubs.rbac.createClusterRoleBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'capo-shell-mcp-read-only' },
        }),
      }),
    );
    expect(stubs.coreV1.createNamespacedServiceAccountToken).toHaveBeenCalledWith({
      name: 'capo-shell-mcp-read-only',
      namespace: 'kube-system',
      body: { spec: { audiences: [], expirationSeconds: 3600 } },
    });
  });

  it('ignores AlreadyExists conflicts for ServiceAccount and updates an existing ClusterRole', async () => {
    const { ApiException } = await import('@kubernetes/client-node');
    mockRbacHappyPath();
    stubs.coreV1.createNamespacedServiceAccount = vi.fn().mockRejectedValue(
      new ApiException(409, 'Conflict', { message: 'already exists' }, {}),
    );
    stubs.rbac.createClusterRole = vi.fn().mockRejectedValue(
      new ApiException(409, 'Conflict', { message: 'already exists' }, {}),
    );
    stubs.rbac.replaceClusterRole = vi.fn().mockResolvedValue({});

    const { createReadOnlyKubeconfig } = await import('../k8s.js');
    await createReadOnlyKubeconfig(adminKcYaml, 3600);

    expect(stubs.rbac.replaceClusterRole).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'capo-shell-mcp-read-only' }),
    );
  });

  it('falls back to delete+recreate when the ClusterRoleBinding roleRef is immutable', async () => {
    const { ApiException } = await import('@kubernetes/client-node');
    mockRbacHappyPath();
    stubs.rbac.createClusterRoleBinding = vi.fn()
      .mockRejectedValueOnce(new ApiException(409, 'Conflict', { message: 'already exists' }, {}))
      .mockResolvedValueOnce({});
    stubs.rbac.replaceClusterRoleBinding = vi.fn().mockRejectedValue(
      new ApiException(422, 'Invalid', {
        message: 'ClusterRoleBinding.rbac.authorization.k8s.io "capo-shell-mcp-read-only" is invalid: roleRef: Invalid value: ...: roleRef is immutable',
      }, {}),
    );
    stubs.rbac.deleteClusterRoleBinding = vi.fn().mockResolvedValue({});

    const { createReadOnlyKubeconfig } = await import('../k8s.js');
    await createReadOnlyKubeconfig(adminKcYaml, 3600);

    expect(stubs.rbac.replaceClusterRoleBinding).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'capo-shell-mcp-read-only' }),
    );
    expect(stubs.rbac.deleteClusterRoleBinding).toHaveBeenCalledWith({ name: 'capo-shell-mcp-read-only' });
    expect(stubs.rbac.createClusterRoleBinding).toHaveBeenCalledTimes(2);
  });

  it('returns kubeconfig YAML with token, server, and CA data', async () => {
    mockRbacHappyPath();

    const { createReadOnlyKubeconfig } = await import('../k8s.js');
    const result = await createReadOnlyKubeconfig(adminKcYaml, 3600);

    const yaml = await import('js-yaml');
    const parsed = yaml.load(result) as {
      clusters: Array<{ cluster: { server: string; 'certificate-authority-data': string } }>;
      users: Array<{ user: { token: string } }>;
      'current-context': string;
    };
    expect(parsed.clusters[0].cluster.server).toBe('https://10.0.0.1:6443');
    expect(parsed.clusters[0].cluster['certificate-authority-data']).toBe('dGVzdC1jYQ==');
    expect(parsed.users[0].user.token).toBe('mytoken');
    expect(parsed['current-context']).toBe('readonly');
  });

  it('throws when the token request returns no token', async () => {
    mockRbacHappyPath();
    stubs.coreV1.createNamespacedServiceAccountToken = vi.fn().mockResolvedValue({ status: {} });
    const { createReadOnlyKubeconfig } = await import('../k8s.js');
    await expect(createReadOnlyKubeconfig(adminKcYaml, 60)).rejects.toThrow(/no token/);
  });

  it('throws when admin kubeconfig has no clusters', async () => {
    const { createReadOnlyKubeconfig } = await import('../k8s.js');
    const empty = 'apiVersion: v1\nkind: Config\nclusters: []\n';
    await expect(createReadOnlyKubeconfig(empty, 60)).rejects.toThrow(/no cluster/);
  });
});
