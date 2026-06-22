import { describe, it, expect, vi, afterEach } from 'vitest';
import { shell } from '../shell.js';

const mgmt = { name: 'prod', kubeconfig: '/kube/prod.yaml', context: undefined };

describe('getContexts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns list of context names', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({ stdout: 'ctx-a\nctx-b\n', stderr: '' });
    const { getContexts } = await import('../k8s.js');
    const result = await getContexts('/kube/prod.yaml');
    expect(result).toEqual(['ctx-a', 'ctx-b']);
    expect(shell.execFile).toHaveBeenCalledWith(
      'kubectl',
      ['config', 'get-contexts', '-o', 'name'],
      expect.objectContaining({ env: expect.objectContaining({ KUBECONFIG: '/kube/prod.yaml' }) }),
    );
  });
});

describe('listClustersForContext', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses cluster list from kubectl json output', async () => {
    const items = [
      { metadata: { name: 'cluster-1', namespace: 'ns-1' } },
      { metadata: { name: 'cluster-2', namespace: 'ns-2' } },
    ];
    vi.spyOn(shell, 'execFile').mockResolvedValue({ stdout: JSON.stringify({ items }), stderr: '' });
    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(mgmt, 'ctx-a');
    expect(result).toEqual([
      { management_cluster: 'prod', context: 'ctx-a', namespace: 'ns-1', name: 'cluster-1' },
      { management_cluster: 'prod', context: 'ctx-a', namespace: 'ns-2', name: 'cluster-2' },
    ]);
  });

  it('returns empty array when no clusters', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({ stdout: JSON.stringify({ items: [] }), stderr: '' });
    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(mgmt, 'ctx-a');
    expect(result).toEqual([]);
  });

  it('populates custom_fields from jq expressions', async () => {
    const kubectlOut = JSON.stringify({ items: [{ metadata: { name: 'cluster-1', namespace: 'ns-1' } }] });
    const jqOut = JSON.stringify([{ friendly_name: 'My Cluster', customer_name: 'acme' }]);

    vi.spyOn(shell, 'execFile')
      .mockResolvedValueOnce({ stdout: kubectlOut, stderr: '' })
      .mockResolvedValueOnce({ stdout: jqOut, stderr: '' });

    const { listClustersForContext } = await import('../k8s.js');
    const customFields = {
      friendly_name: '.metadata.annotations["example.com/name"] | @base64d',
      customer_name: '.metadata.labels["example.com/customer"]',
    };
    const result = await listClustersForContext(mgmt, 'ctx-a', customFields);
    expect(result[0].custom_fields).toEqual({ friendly_name: 'My Cluster', customer_name: 'acme' });
  });

  it('skips null/empty custom field values', async () => {
    const kubectlOut = JSON.stringify({ items: [{ metadata: { name: 'c', namespace: 'ns' } }] });
    const jqOut = JSON.stringify([{ friendly_name: null, customer_name: '' }]);

    vi.spyOn(shell, 'execFile')
      .mockResolvedValueOnce({ stdout: kubectlOut, stderr: '' })
      .mockResolvedValueOnce({ stdout: jqOut, stderr: '' });

    const { listClustersForContext } = await import('../k8s.js');
    const customFields = { friendly_name: '.metadata.annotations["missing"] // null', customer_name: '""' };
    const result = await listClustersForContext(mgmt, 'ctx-a', customFields);
    expect(result[0].custom_fields).toBeUndefined();
  });
});

describe('fetchWorkloadKubeconfig', () => {
  afterEach(() => vi.restoreAllMocks());

  it('base64-decodes the secret value', async () => {
    const rawKubeconfig = 'apiVersion: v1\nclusters: []';
    const encoded = Buffer.from(rawKubeconfig).toString('base64');
    vi.spyOn(shell, 'execFile').mockResolvedValue({ stdout: encoded, stderr: '' });
    const { fetchWorkloadKubeconfig } = await import('../k8s.js');
    const result = await fetchWorkloadKubeconfig(mgmt, 'ctx-a', 'ns-1', 'cluster-1');
    expect(result).toBe(rawKubeconfig);
    expect(shell.execFile).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining(['-n', 'ns-1', 'get', 'secret', 'cluster-1-kubeconfig']),
      expect.anything(),
    );
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
    const oscJson = JSON.stringify({
      items: [{
        spec: { identityRef: { name: 'os-creds' }, cloudName: 'openstack' },
      }],
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

    vi.spyOn(shell, 'execFile')
      .mockResolvedValueOnce({ stdout: oscJson, stderr: '' })
      .mockResolvedValueOnce({ stdout: encoded, stderr: '' });

    const { fetchOpenStackEnv } = await import('../k8s.js');
    const env = await fetchOpenStackEnv(mgmt, 'ctx-a', 'ns-1', 'cluster-1');

    // Assert label selector was used
    expect(shell.execFile).toHaveBeenNthCalledWith(
      1,
      'kubectl',
      expect.arrayContaining([
        'get', 'openstackcluster',
        '-l', 'cluster.x-k8s.io/cluster-name=cluster-1',
      ]),
      expect.anything(),
    );

    expect(env.OS_AUTH_URL).toBe('https://keystone.example.com/v3');
    expect(env.OS_APPLICATION_CREDENTIAL_ID).toBe('cred-id');
    expect(env.OS_APPLICATION_CREDENTIAL_SECRET).toBe('cred-secret');
    expect(env.OS_REGION_NAME).toBe('RegionOne');
  });

  it('throws when no OpenStackCluster found', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({
      stdout: JSON.stringify({ items: [] }),
      stderr: '',
    });
    const { fetchOpenStackEnv } = await import('../k8s.js');
    await expect(fetchOpenStackEnv(mgmt, 'ctx-a', 'ns-1', 'cluster-1'))
      .rejects.toThrow(/No OpenStackCluster found/);
  });
});

describe('fetchApiServerInfo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null when no items', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({
      stdout: JSON.stringify({ items: [] }),
      stderr: '',
    });
    const { fetchApiServerInfo } = await import('../k8s.js');
    expect(await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1')).toBeNull();
  });

  it('returns null when no allowedCIDRs', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({
      stdout: JSON.stringify({
        items: [{ spec: { controlPlaneEndpoint: { host: '10.0.0.1' } } }],
      }),
      stderr: '',
    });
    const { fetchApiServerInfo } = await import('../k8s.js');
    expect(await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1')).toBeNull();
  });

  it('returns API server IP when allowedCIDRs present', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({
      stdout: JSON.stringify({
        items: [{
          spec: {
            apiServerLoadBalancer: { allowedCIDRs: ['0.0.0.0/0'] },
            controlPlaneEndpoint: { host: '10.0.0.1' },
          },
        }],
      }),
      stderr: '',
    });
    const { fetchApiServerInfo } = await import('../k8s.js');
    expect(await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1')).toBe('10.0.0.1');
  });

  it('uses label selector', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({
      stdout: JSON.stringify({ items: [] }),
      stderr: '',
    });
    const { fetchApiServerInfo } = await import('../k8s.js');
    await fetchApiServerInfo(mgmt, 'ctx-a', 'ns-1', 'cluster-1');
    expect(shell.execFile).toHaveBeenCalledWith(
      'kubectl',
      expect.arrayContaining([
        'get', 'openstackcluster',
        '-l', 'cluster.x-k8s.io/cluster-name=cluster-1',
      ]),
      expect.anything(),
    );
  });
});
