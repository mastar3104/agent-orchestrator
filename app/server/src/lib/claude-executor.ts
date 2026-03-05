import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Types ───

export interface ClaudeExecutionOptions {
  prompt: string;
  allowedTools: string[];
  jsonSchema: object;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ClaudeExecutionResult<T = unknown> {
  output: T;
  rawStdout: string;
  exitCode: number;
  stderr: string;
  durationMs: number;
}

export class ClaudeExecutionError extends Error {
  exitCode: number;
  stderr: string;
  stdout: string;
  durationMs: number;

  constructor(message: string, exitCode: number, stderr: string, stdout: string, durationMs: number) {
    super(message);
    this.name = 'ClaudeExecutionError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
    this.durationMs = durationMs;
  }
}

export class ClaudeSchemaValidationError extends Error {
  rawOutput: string;
  validationErrors: string[];
  stderr: string;
  exitCode: number;
  durationMs: number;

  constructor(message: string, rawOutput: string, validationErrors: string[], stderr: string, exitCode: number, durationMs: number) {
    super(message);
    this.name = 'ClaudeSchemaValidationError';
    this.rawOutput = rawOutput;
    this.validationErrors = validationErrors;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.durationMs = durationMs;
  }
}

// ─── Claude path resolution ───

let cachedClaudePath: string | null = null;

export function findClaudePath(): string {
  if (cachedClaudePath) {
    return cachedClaudePath;
  }

  const possiblePaths = [
    join(homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    join(homedir(), '.local', 'bin', 'claude'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      cachedClaudePath = p;
      return p;
    }
  }

  // Fallback to just 'claude' and hope it's in PATH
  return 'claude';
}

// ─── Core execution ───

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export async function runClaude<T>(options: ClaudeExecutionOptions): Promise<ClaudeExecutionResult<T>> {
  const claudePath = process.env.CLAUDE_PATH || findClaudePath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(options.jsonSchema),
  ];

  // Add allowed tools (comma-separated to avoid variadic arg consuming the prompt)
  if (options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','));
  }

  // Log the command for debugging (truncate prompt for readability)
  const promptSnippet = options.prompt.length > 200
    ? options.prompt.slice(0, 200) + `... (${options.prompt.length} chars)`
    : options.prompt;
  console.log(`[claude-executor] spawn: ${claudePath} ${args.map(a => a.length > 100 ? a.slice(0, 100) + '...' : a).join(' ')}`);
  console.log(`[claude-executor] cwd: ${options.cwd} | timeout: ${timeoutMs}ms | prompt (stdin): ${promptSnippet}`);

  const startTime = Date.now();

  return new Promise<ClaudeExecutionResult<T>>((resolve, reject) => {
    const proc = spawn(claudePath, args, {
      cwd: options.cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...options.env,
      },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let exited = false;

    // Send prompt via stdin to avoid variadic --allowedTools consuming it
    if (proc.stdin) {
      proc.stdin.on('error', (err) => {
        console.error(`[claude-executor] stdin error: ${err.message}`);
      });
      proc.stdin.end(options.prompt);
    }

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });

    // Timeout handling
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      // Give 5s for graceful shutdown, then force kill
      setTimeout(() => {
        if (!exited) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMs);

    // AbortSignal handling
    const onAbort = () => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!exited) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    };

    if (options.signal) {
      if (options.signal.aborted) {
        proc.kill('SIGTERM');
        clearTimeout(timer);
        reject(new ClaudeExecutionError('Aborted before start', -1, '', '', 0));
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    proc.on('close', (code) => {
      exited = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);

      const durationMs = Date.now() - startTime;
      const exitCode = code ?? -1;

      if (killed) {
        const stderrSnippet = stderr.slice(0, 500);
        const stdoutSnippet = stdout.slice(0, 500);
        reject(new ClaudeExecutionError(
          `Claude process killed (timeout or abort) after ${Math.round(durationMs / 1000)}s. stderr: ${stderrSnippet || '(empty)'} stdout: ${stdoutSnippet || '(empty)'}`,
          exitCode,
          stderr,
          stdout,
          durationMs
        ));
        return;
      }

      if (exitCode !== 0) {
        reject(new ClaudeExecutionError(
          `Claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
          exitCode,
          stderr,
          stdout,
          durationMs
        ));
        return;
      }

      // Parse JSON output
      let parsed: T;
      try {
        // claude -p --output-format json returns a JSON object with a "result" field
        // The actual response is in the result field
        const rawParsed = JSON.parse(stdout);
        // If the output has a result field containing the schema'd response, extract it
        if (rawParsed && typeof rawParsed === 'object' && 'result' in rawParsed) {
          // --json-schema 指定時は structured_output に構造化出力が入る
          if ('structured_output' in rawParsed && rawParsed.structured_output != null) {
            parsed = rawParsed.structured_output as T;
          } else {
            const resultValue = rawParsed.result;
            if (typeof resultValue === 'string') {
              try {
                parsed = JSON.parse(resultValue) as T;
              } catch {
                parsed = resultValue as T;
              }
            } else {
              parsed = resultValue as T;
            }
          }
        } else {
          parsed = rawParsed as T;
        }
      } catch {
        reject(new ClaudeSchemaValidationError(
          'Failed to parse JSON output from Claude',
          stdout,
          ['Invalid JSON output'],
          stderr,
          exitCode,
          durationMs
        ));
        return;
      }

      resolve({
        output: parsed,
        rawStdout: stdout,
        exitCode,
        stderr,
        durationMs,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(new ClaudeExecutionError(
        `Failed to spawn Claude: ${err.message}`,
        -1,
        err.message,
        stdout,
        0
      ));
    });
  });
}

// ─── Retry utility ───

export interface ValidationContext {
  workingDir: string;
  agentId: string;
  attemptBefore: string; // git rev-parse HEAD captured inside each attempt
}

export interface ExecuteWithRetryOptions<T> extends ClaudeExecutionOptions {
  agentId: string;
  maxAttempts?: number;
  validate?: (result: T, ctx: ValidationContext) => Promise<string | null>;
}

async function captureGitHead(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'pipe' });
    let stdout = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else resolve('unknown'); // Don't fail if not a git repo
    });
    proc.on('error', () => resolve('unknown'));
  });
}

export async function executeWithRetry<T>(
  options: ExecuteWithRetryOptions<T>
): Promise<ClaudeExecutionResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: Error | null = null;
  let lastFailureReason: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Capture git HEAD inside each attempt
    const attemptBefore = await captureGitHead(options.cwd);

    // Build prompt with retry context
    let prompt = options.prompt;
    if (attempt > 1 && lastFailureReason) {
      prompt += `\n\n## Retry Context\nThis is retry attempt ${attempt} of ${maxAttempts}.\nFailure reason: ${lastFailureReason}\nYou must correct this issue. Output strictly valid JSON.`;
    }

    try {
      const result = await runClaude<T>({
        ...options,
        prompt,
      });

      // Run validation if provided
      if (options.validate) {
        const validationError = await options.validate(result.output, {
          workingDir: options.cwd,
          agentId: options.agentId,
          attemptBefore,
        });

        if (validationError) {
          lastFailureReason = validationError;
          lastError = new Error(`Validation failed on attempt ${attempt}: ${validationError}`);
          console.warn(`[${options.agentId}] Attempt ${attempt}/${maxAttempts} validation failed: ${validationError}`);
          continue;
        }
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastFailureReason = lastError.message;
      console.warn(`[${options.agentId}] Attempt ${attempt}/${maxAttempts} failed: ${lastError.message}`);
    }
  }

  throw lastError ?? new Error(`All ${maxAttempts} attempts failed`);
}

/**
 * Get a reference to the spawned process for external kill.
 * Used by agent-service to track running processes.
 */
export interface SpawnedProcess {
  proc: ChildProcess;
  abort: AbortController;
}
