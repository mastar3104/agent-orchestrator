import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { finished } from 'stream/promises';
import type { HookResult } from '@agent-orch/shared';

export const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 2000;

function truncateOutput(output: string, maxLength: number = MAX_OUTPUT_LENGTH): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + '...(truncated)';
}

export async function runShellCommands(
  commands: string[],
  cwd: string,
  options: {
    logDir: string;
    attempt: number;
    timeoutMs?: number;
    stopOnError?: boolean;
  }
): Promise<HookResult[]> {
  const {
    logDir,
    attempt,
    timeoutMs = COMMAND_TIMEOUT_MS,
    stopOnError = false,
  } = options;

  const attemptDir = join(logDir, `attempt-${attempt}`);
  await mkdir(attemptDir, { recursive: true });
  const results: HookResult[] = [];

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];
    const stdoutPath = join(attemptDir, `command-${i}.stdout.log`);
    const stderrPath = join(attemptDir, `command-${i}.stderr.log`);
    const startTime = Date.now();

    const result = await new Promise<HookResult>((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const stdoutStream = createWriteStream(stdoutPath);
      const stderrStream = createWriteStream(stderrPath);

      let stdoutBuf = '';
      let stderrBuf = '';

      const proc = spawn('sh', ['-c', command], {
        cwd,
        stdio: 'pipe',
        signal: controller.signal,
      });

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (stdoutBuf.length < MAX_OUTPUT_LENGTH) stdoutBuf += text;
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (stderrBuf.length < MAX_OUTPUT_LENGTH) stderrBuf += text;
      });

      proc.stdout?.pipe(stdoutStream);
      proc.stderr?.pipe(stderrStream);

      proc.on('close', async (code, signal) => {
        clearTimeout(timer);
        stdoutStream.end();
        stderrStream.end();
        try {
          await Promise.all([finished(stdoutStream), finished(stderrStream)]);
        } catch {
          // Log write failure is not fatal.
        }
        resolve({
          command,
          exitCode: code,
          stdout: truncateOutput(stdoutBuf),
          stderr: truncateOutput(stderrBuf),
          stdoutLogPath: stdoutPath,
          stderrLogPath: stderrPath,
          durationMs: Date.now() - startTime,
          timedOut: false,
          signal: signal || undefined,
        });
      });

      proc.on('error', async (error) => {
        clearTimeout(timer);
        stdoutStream.end();
        stderrStream.end();
        try {
          await Promise.all([finished(stdoutStream), finished(stderrStream)]);
        } catch {
          // Log write failure is not fatal.
        }
        const isAbort = error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR';
        if (isAbort) {
          await writeFile(stderrPath, `Timed out after ${timeoutMs}ms`).catch(() => {});
        }
        resolve({
          command,
          exitCode: null,
          stdout: truncateOutput(stdoutBuf),
          stderr: truncateOutput(isAbort ? `Timed out after ${timeoutMs}ms` : error.message),
          stdoutLogPath: stdoutPath,
          stderrLogPath: stderrPath,
          durationMs: Date.now() - startTime,
          timedOut: isAbort,
          signal: isAbort ? 'SIGTERM' : undefined,
        });
      });
    });

    results.push(result);

    if (stopOnError && (result.exitCode !== 0 || result.timedOut)) {
      break;
    }
  }

  return results;
}
