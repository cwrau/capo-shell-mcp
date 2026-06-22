import { shell } from './shell.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execWithKubeconfig(
  workloadKubeconfig: string,
  openstackEnv: Record<string, string>,
  command: string[],
): Promise<ExecResult> {
  if (command.length === 0) throw new Error('exec: command must be non-empty');

  const tmpFile = path.join(
    os.tmpdir(),
    `capo-shell-mcp-${Math.random().toString(36).slice(2)}.yaml`,
  );

  await fs.writeFile(tmpFile, workloadKubeconfig, { mode: 0o600 });

  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ...openstackEnv, KUBECONFIG: tmpFile };
    const [bin, ...args] = command;

    try {
      const { stdout, stderr } = await shell.execFile(bin, args, {
        env,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? String(err),
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  } finally {
    await fs.unlink(tmpFile).catch(() => undefined);
  }
}
