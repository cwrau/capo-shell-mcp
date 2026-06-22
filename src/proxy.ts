import { spawn, type ChildProcess } from 'node:child_process';

interface ProxyEntry {
  process: ChildProcess;
  timer: ReturnType<typeof setTimeout>;
}

const proxyStore = new Map<string, ProxyEntry>();

export const proxyShell = {
  spawn(host: string, ip: string): ChildProcess {
    return spawn('sshuttle', ['-r', host, `${ip}/32`], { stdio: 'ignore' });
  },
};

export function killProxy(key: string): void {
  const entry = proxyStore.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.process.kill('SIGTERM');
  proxyStore.delete(key);
}

export function killAllProxies(): void {
  for (const key of [...proxyStore.keys()]) killProxy(key);
}

export function refreshProxy(key: string, ttlSeconds: number): void {
  const entry = proxyStore.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => killProxy(key), ttlSeconds * 1000);
}

export async function ensureProxy(
  key: string,
  sshuttleHost: string,
  apiServerIp: string,
  ttlSeconds: number,
): Promise<void> {
  if (proxyStore.has(key)) {
    refreshProxy(key, ttlSeconds);
    return;
  }

  const proc = proxyShell.spawn(sshuttleHost, apiServerIp);
  proc.unref();

  // Wait up to 1s for sshuttle to start; reject if it dies first
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 1000);
    proc.once('error', (err) => { clearTimeout(t); reject(err); });
    proc.once('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`sshuttle exited early with code ${code ?? 'unknown'}`));
    });
  });

  const killTimer = setTimeout(() => killProxy(key), ttlSeconds * 1000);
  proxyStore.set(key, { process: proc, timer: killTimer });

  // If sshuttle exits after startup, remove the dead entry from the store
  proc.once('exit', () => {
    const entry = proxyStore.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      proxyStore.delete(key);
    }
  });
}

process.on('exit', killAllProxies);
process.on('SIGINT', () => { killAllProxies(); process.exit(0); });
process.on('SIGTERM', () => { killAllProxies(); process.exit(0); });
