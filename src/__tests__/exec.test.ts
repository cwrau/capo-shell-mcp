import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shell } from '../shell.js';
import * as fsPromises from 'node:fs/promises';

vi.mock('node:fs/promises');

describe('execWithKubeconfig', () => {
  beforeEach(() => {
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.unlink).mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('runs command and returns stdout/stderr on success', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({ stdout: 'hello\n', stderr: '' });
    const { execWithKubeconfig } = await import('../exec.js');
    const result = await execWithKubeconfig('kc-content', {}, ['echo', 'hello']);
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exitCode on command failure', async () => {
    vi.spyOn(shell, 'execFile').mockRejectedValue(
      Object.assign(new Error('failed'), { code: 1, stdout: '', stderr: 'error msg' }),
    );
    const { execWithKubeconfig } = await import('../exec.js');
    const result = await execWithKubeconfig('kc-content', {}, ['false']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('error msg');
  });

  it('always deletes the temp file on success', async () => {
    vi.spyOn(shell, 'execFile').mockResolvedValue({ stdout: '', stderr: '' });
    const { execWithKubeconfig } = await import('../exec.js');
    await execWithKubeconfig('kc', {}, ['true']);
    expect(fsPromises.unlink).toHaveBeenCalledOnce();
  });

  it('always deletes the temp file on failure', async () => {
    vi.spyOn(shell, 'execFile').mockRejectedValue(
      Object.assign(new Error('x'), { code: 2, stdout: '', stderr: '' }),
    );
    const { execWithKubeconfig } = await import('../exec.js');
    await execWithKubeconfig('kc', {}, ['false']);
    expect(fsPromises.unlink).toHaveBeenCalledOnce();
  });

  it('throws when command array is empty', async () => {
    const { execWithKubeconfig } = await import('../exec.js');
    await expect(execWithKubeconfig('kc', {}, [])).rejects.toThrow(/non-empty/);
  });

  it('sets KUBECONFIG and OS env vars on the child process', async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    vi.spyOn(shell, 'execFile').mockImplementation(async (_bin, _args, opts) => {
      capturedOpts = opts as Record<string, unknown>;
      return { stdout: '', stderr: '' };
    });
    const { execWithKubeconfig } = await import('../exec.js');
    await execWithKubeconfig('kc', { OS_AUTH_URL: 'https://ks.example.com' }, ['true']);
    const env = capturedOpts?.env as NodeJS.ProcessEnv;
    expect(env?.OS_AUTH_URL).toBe('https://ks.example.com');
    expect(env?.KUBECONFIG).toMatch(/capo-shell-mcp-.*\.yaml$/);
  });
});
