import { execFile as _execFile } from 'node:child_process';

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  input?: string;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
}

export const shell = {
  execFile(file: string, args: string[], options: ExecOptions): Promise<ExecOutput> {
    return new Promise((resolve, reject) => {
      const proc = _execFile(file, args, options, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
      if (options.input !== undefined && proc.stdin) {
        proc.stdin.write(options.input);
        proc.stdin.end();
      }
    });
  },
};
