/**
 * Integration tests — the Kubernetes API client is mocked, jq runs for real.
 * Validates actual jq expressions used in production config.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { shell } from '../shell.js';

vi.mock('node:fs');

// Capture original before any spy replaces it — jq still runs for real
const realExecFile = shell.execFile.bind(shell);
function spyOnJq() {
  vi.spyOn(shell, 'execFile').mockImplementation(realExecFile);
}

const stubs = vi.hoisted(() => ({
  customObjects: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('@kubernetes/client-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kubernetes/client-node')>();

  class FakeKubeConfig {
    loadFromFile(_path: string) {}
    loadFromString(_yaml: string) {}
    setCurrentContext(_ctx: string) {}
    makeApiClient(apiClientType: unknown) {
      if (apiClientType === actual.CustomObjectsApi) return stubs.customObjects;
      throw new Error('unexpected api client type in test');
    }
  }

  return { ...actual, KubeConfig: FakeKubeConfig };
});

function mockClusterList(items: unknown[]) {
  stubs.customObjects.listCustomObjectForAllNamespaces = vi.fn().mockResolvedValue({ items });
}

const mgmt = { name: 'prod', kubeconfig: '/kube/prod.yaml', context: undefined };

// ── listClustersForContext + custom_fields ────────────────────────────────────

describe('custom_fields with real jq', () => {
  afterEach(() => vi.restoreAllMocks());

  const FRIENDLY_NAME_EXPR = '.metadata.annotations["t8s.teuto.net/cluster"] // "" | try @base64d';
  const CUSTOMER_NAME_EXPR =
    '(.metadata.annotations["t8s.teuto.net/customer-name"] | if . != null then try @base64d else null end) // .metadata.labels["t8s.teuto.net/customer-id"]';

  it('decodes base64-encoded friendly name from annotation', async () => {
    const friendlyName = 'my-customer-cluster';
    const items = [{
      metadata: {
        name: 'cluster-abc', namespace: 'ns-1',
        annotations: { 't8s.teuto.net/cluster': Buffer.from(friendlyName).toString('base64') },
        labels: {},
      },
    }];
    mockClusterList(items);

    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(
      mgmt,
      'ctx',
      { friendly_name: FRIENDLY_NAME_EXPR },
    );

    expect(result[0].custom_fields?.friendly_name).toBe(friendlyName);
  });

  it('returns empty string (omitted) when friendly name annotation is absent', async () => {
    const items = [{
      metadata: { name: 'cluster-abc', namespace: 'ns-1', annotations: {}, labels: {} },
    }];
    mockClusterList(items);

    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(
      mgmt,
      'ctx',
      { friendly_name: FRIENDLY_NAME_EXPR },
    );

    // "" after base64d fails → try returns null → omitted by our filter
    expect(result[0].custom_fields).toBeUndefined();
  });

  it('uses customer-name annotation (base64) when present', async () => {
    const customerName = 'Acme Corp';
    const items = [{
      metadata: {
        name: 'cluster-abc', namespace: 'ns-1',
        annotations: {
          't8s.teuto.net/customer-name': Buffer.from(customerName).toString('base64'),
        },
        labels: { 't8s.teuto.net/customer-id': 'acme' },
      },
    }];
    mockClusterList(items);

    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(
      mgmt,
      'ctx',
      { customer_name: CUSTOMER_NAME_EXPR },
    );

    expect(result[0].custom_fields?.customer_name).toBe(customerName);
  });

  it('falls back to customer-id label when customer-name annotation is absent', async () => {
    const items = [{
      metadata: {
        name: 'cluster-abc', namespace: 'ns-1',
        annotations: {},
        labels: { 't8s.teuto.net/customer-id': 'acme-42' },
      },
    }];
    mockClusterList(items);

    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(
      mgmt,
      'ctx',
      { customer_name: CUSTOMER_NAME_EXPR },
    );

    expect(result[0].custom_fields?.customer_name).toBe('acme-42');
  });

  it('evaluates all fields in one jq call across multiple clusters', async () => {
    spyOnJq();
    const items = [
      {
        metadata: {
          name: 'cluster-1', namespace: 'ns-1',
          annotations: { 't8s.teuto.net/customer-name': Buffer.from('Alpha').toString('base64') },
          labels: {},
        },
      },
      {
        metadata: {
          name: 'cluster-2', namespace: 'ns-2',
          annotations: {},
          labels: { 't8s.teuto.net/customer-id': 'beta' },
        },
      },
    ];
    mockClusterList(items);

    const { listClustersForContext } = await import('../k8s.js');
    const result = await listClustersForContext(
      mgmt,
      'ctx',
      { customer_name: CUSTOMER_NAME_EXPR },
    );

    expect(result[0].custom_fields?.customer_name).toBe('Alpha');
    expect(result[1].custom_fields?.customer_name).toBe('beta');
    // Verify only one jq call was made across both clusters
    expect(shell.execFile).toHaveBeenCalledTimes(1);
  });
});

// ── applyKubeconfigTransform with real jq ────────────────────────────────────

describe('applyKubeconfigTransform with real jq', () => {
  const OIDC_USERS_EXPR =
    '{name: .name, user: {exec: {' +
    'apiVersion: "client.authentication.k8s.io/v1beta1", command: "kubectl", ' +
    'args: ["oidc-login", "get-token", "--oidc-issuer-url=https://staff-auth.k8s.teuto.net", ' +
    '"--oidc-client-id=kubernetes"]}}}';

  const KC_WITH_CERT = `
apiVersion: v1
clusters:
  - cluster:
      server: https://10.0.0.1:6443
      certificate-authority-data: abc123
    name: workload
contexts:
  - context:
      cluster: workload
      user: admin
    name: workload-admin
current-context: workload-admin
users:
  - name: admin
    user:
      client-certificate-data: certdata
      client-key-data: keydata
`;

  it('replaces certificate-based user with OIDC exec plugin', async () => {
    const { applyKubeconfigTransform } = await import('../k8s.js');
    const result = await applyKubeconfigTransform(KC_WITH_CERT, { users: OIDC_USERS_EXPR });

    const { load } = await import('js-yaml');
    const kc = load(result) as {
      users: Array<{ name: string; user: { exec: { command: string; args: string[] } } }>;
    };

    expect(kc.users).toHaveLength(1);
    expect(kc.users[0].name).toBe('admin');
    expect(kc.users[0].user.exec.command).toBe('kubectl');
    expect(kc.users[0].user.exec.args).toContain('oidc-login');
    expect(result).not.toContain('client-certificate-data');
    expect(result).not.toContain('client-key-data');
  });

  it('preserves cluster and context entries unchanged', async () => {
    const { applyKubeconfigTransform } = await import('../k8s.js');
    const result = await applyKubeconfigTransform(KC_WITH_CERT, { users: OIDC_USERS_EXPR });

    const { load } = await import('js-yaml');
    const kc = load(result) as { clusters: unknown[]; contexts: unknown[] };

    expect(kc.clusters).toHaveLength(1);
    expect(kc.contexts).toHaveLength(1);
  });
});

// ── expandEnv in loadConfig ──────────────────────────────────────────────────

describe('env var expansion in config', () => {
  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReturnValue('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('expands $VAR in kubeconfig path', async () => {
    process.env._TEST_KC_DIR = '/tmp/kube';
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: $_TEST_KC_DIR/prod
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().management_clusters[0].kubeconfig).toBe('/tmp/kube/prod');
    delete process.env._TEST_KC_DIR;
  });

  it('expands ${VAR} in kubeconfig path', async () => {
    process.env._TEST_KC_DIR = '/tmp/kube';
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: \${_TEST_KC_DIR}/prod
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().management_clusters[0].kubeconfig).toBe('/tmp/kube/prod');
    delete process.env._TEST_KC_DIR;
  });

  it('expands multiple vars in one path', async () => {
    process.env._TEST_BASE = '/home/test';
    process.env._TEST_SUFFIX = 'mgmt';
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: $_TEST_BASE/.config/kube/$_TEST_SUFFIX
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().management_clusters[0].kubeconfig).toBe('/home/test/.config/kube/mgmt');
    delete process.env._TEST_BASE;
    delete process.env._TEST_SUFFIX;
  });

  it('expands env vars in sshuttle_host', async () => {
    process.env._TEST_BASTION = 'jump.internal';
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /tmp/kc
    sshuttle_host: ops@$_TEST_BASTION
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().management_clusters[0].sshuttle_host).toBe('ops@jump.internal');
    delete process.env._TEST_BASTION;
  });

  it('replaces undefined vars with empty string', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /base/$_SURELY_UNSET_VAR_XYZ/prod
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().management_clusters[0].kubeconfig).toBe('/base//prod');
  });

  it('does not expand vars in jq expressions (transforms)', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /tmp/kc
transforms:
  users: '.name | $__loc__'
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().transforms?.users).toBe('.name | $__loc__');
  });

  it('does not expand vars in custom_fields expressions', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /tmp/kc
custom_fields:
  name: '.metadata.labels["$HOME"]'
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(loadConfig().custom_fields?.name).toBe('.metadata.labels["$HOME"]');
  });
});
