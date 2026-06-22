import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs');

const VALID_YAML = `
management_clusters:
  - name: prod
    kubeconfig: /home/user/.kube/prod.yaml
  - name: dev
    kubeconfig: /home/user/.kube/dev.yaml
    context: dev-admin
cache:
  cluster_list_ttl: 60
  kubeconfig_ttl: 120
`;

const MINIMAL_YAML = `
management_clusters:
  - name: only
    kubeconfig: /tmp/only.yaml
`;

describe('loadConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.mocked(fs.readFileSync).mockReturnValue(VALID_YAML);
    delete process.env.CAPO_SHELL_MCP_CONFIG;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('parses a valid config with two clusters', async () => {
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.management_clusters).toHaveLength(2);
    expect(cfg.management_clusters[0]).toMatchObject({ name: 'prod', kubeconfig: '/home/user/.kube/prod.yaml', context: undefined });
    expect(cfg.management_clusters[1]).toMatchObject({ name: 'dev', kubeconfig: '/home/user/.kube/dev.yaml', context: 'dev-admin' });
  });

  it('parses global transforms', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /tmp/kc.yaml
transforms:
  users: '{name: .name, user: {exec: {}}}'
  clusters: '.cluster.server = "https://custom.host:6443"'
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.transforms).toEqual({
      users: '{name: .name, user: {exec: {}}}',
      clusters: '.cluster.server = "https://custom.host:6443"',
    });
  });

  it('parses global custom_fields', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /tmp/kc.yaml
custom_fields:
  customer_name: '.metadata.labels["example.com/customer"]'
  tier: '.metadata.labels["example.com/tier"]'
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.custom_fields).toEqual({
      customer_name: '.metadata.labels["example.com/customer"]',
      tier: '.metadata.labels["example.com/tier"]',
    });
  });

  it('parses global and per-cluster sshuttle_host', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /tmp/kc.yaml
    sshuttle_host: user@bastion.example.com
  - name: dev
    kubeconfig: /tmp/kc2.yaml
sshuttle_host: gateway
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.sshuttle_host).toBe('gateway');
    expect(cfg.management_clusters[0].sshuttle_host).toBe('user@bastion.example.com');
    expect(cfg.management_clusters[1].sshuttle_host).toBeUndefined();
  });

  it('expands env vars in kubeconfig and per-cluster sshuttle_host', async () => {
    process.env.TEST_XDG = '/home/test/.config';
    process.env.TEST_BASTION = 'ops@jump.example.com';
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: $TEST_XDG/kube/prod
    sshuttle_host: $TEST_BASTION
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.management_clusters[0].kubeconfig).toBe('/home/test/.config/kube/prod');
    expect(cfg.management_clusters[0].sshuttle_host).toBe('ops@jump.example.com');
    delete process.env.TEST_XDG;
    delete process.env.TEST_BASTION;
  });

  it('expands env vars in global sshuttle_host', async () => {
    process.env.TEST_GW = 'gw.example.com';
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: /tmp/kc.yaml
sshuttle_host: $TEST_GW
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.sshuttle_host).toBe('gw.example.com');
    delete process.env.TEST_GW;
  });

  it('expands ${VAR} syntax too', async () => {
    process.env.TEST_HOME = '/home/test';
    vi.mocked(fs.readFileSync).mockReturnValue(`
management_clusters:
  - name: prod
    kubeconfig: \${TEST_HOME}/.kube/prod
`);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.management_clusters[0].kubeconfig).toBe('/home/test/.kube/prod');
    delete process.env.TEST_HOME;
  });

  it('sets optional fields to undefined when absent', async () => {
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.management_clusters[0].sshuttle_host).toBeUndefined();
    expect(cfg.transforms).toBeUndefined();
    expect(cfg.custom_fields).toBeUndefined();
    expect(cfg.sshuttle_host).toBeUndefined();
  });

  it('parses cache settings', async () => {
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.cache.cluster_list_ttl).toBe(60);
    expect(cfg.cache.kubeconfig_ttl).toBe(120);
  });

  it('uses default cache values when cache section is absent', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue(MINIMAL_YAML);
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    expect(cfg.cache.cluster_list_ttl).toBe(300);
    expect(cfg.cache.kubeconfig_ttl).toBe(3600);
  });

  it('throws when management_clusters is missing', async () => {
    vi.mocked(fs.readFileSync).mockReturnValue('cache:\n  cluster_list_ttl: 10\n');
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    expect(() => loadConfig()).toThrow(/management_clusters/);
  });

  it('uses CAPO_SHELL_MCP_CONFIG env var for config path', async () => {
    process.env.CAPO_SHELL_MCP_CONFIG = '/custom/path/config.yaml';
    vi.resetModules();
    const { loadConfig } = await import('../config.js');
    loadConfig();
    expect(fs.readFileSync).toHaveBeenCalledWith('/custom/path/config.yaml', 'utf8');
  });
});
