import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Types ───

export interface ClaudeExecutionOptions {
  prompt: string;
  appendSystemPrompt?: string;
  addDirs?: string[];
  allowedTools: string[];
  jsonSchema?: object;
  schemaFallbackMode?: ClaudeSchemaFallbackMode;
  cwd: string;
  resumeSessionId?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ClaudeSchemaFallbackMode = 'strict' | 'result_or_empty';

export interface ClaudeExecutionResult<T = unknown> {
  output: T;
  rawStdout: string;
  usedSchemaFallback?: boolean;
  schemaValidationErrors?: string[];
  sessionId?: string;
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

// ─── Lightweight JSON Schema validator ───

/**
 * プロジェクトの jsonSchema で使用する機能のみ対応する軽量バリデータ。
 * 対応: type (object/string/number/array), enum, required, properties, items
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path: string = '$',
): string[] {
  const errors: string[] = [];

  if (Object.keys(schema).length === 0) {
    return errors;
  }

  const expectedType = schema.type as string | undefined;

  if (expectedType) {
    const actualType = getJsonSchemaType(value);
    if (actualType !== expectedType) {
      errors.push(`${path}: expected type '${expectedType}' but got '${actualType}'`);
      return errors;
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: value ${JSON.stringify(value)} not in enum [${schema.enum.map((v: unknown) => JSON.stringify(v)).join(', ')}]`);
    }
  }

  if (expectedType === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in obj)) {
          errors.push(`${path}: missing required field '${key}'`);
        }
      }
    }

    if (schema.properties && typeof schema.properties === 'object') {
      const props = schema.properties as Record<string, Record<string, unknown>>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj) {
          errors.push(...validateAgainstSchema(obj[key], propSchema, `${path}.${key}`));
        }
      }
    }
  }

  if (expectedType === 'array' && Array.isArray(value)) {
    if (schema.items && typeof schema.items === 'object') {
      const itemSchema = schema.items as Record<string, unknown>;
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateAgainstSchema(value[i], itemSchema, `${path}[${i}]`));
      }
    }
  }

  return errors;
}

function getJsonSchemaType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
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

function extractClaudeOutput(stdout: string): {
  parsedOutput: unknown;
  rawResult: unknown;
  hasResult: boolean;
  sessionId?: string;
} {
  const rawParsed = JSON.parse(stdout);

  let sessionId: string | undefined;
  if (
    rawParsed &&
    typeof rawParsed === 'object' &&
    'session_id' in rawParsed &&
    typeof rawParsed.session_id === 'string'
  ) {
    sessionId = rawParsed.session_id;
  }

  if (rawParsed && typeof rawParsed === 'object' && 'result' in rawParsed) {
    const rawResult = rawParsed.result;

    if ('structured_output' in rawParsed && rawParsed.structured_output != null) {
      return {
        parsedOutput: rawParsed.structured_output,
        rawResult,
        hasResult: true,
        sessionId,
      };
    }

    if (typeof rawResult === 'string') {
      try {
        return {
          parsedOutput: JSON.parse(rawResult),
          rawResult,
          hasResult: true,
          sessionId,
        };
      } catch {
        return {
          parsedOutput: rawResult,
          rawResult,
          hasResult: true,
          sessionId,
        };
      }
    }

    return {
      parsedOutput: rawResult,
      rawResult,
      hasResult: true,
      sessionId,
    };
  }

  return {
    parsedOutput: rawParsed,
    rawResult: '',
    hasResult: false,
    sessionId,
  };
}

export async function runClaude<T>(options: ClaudeExecutionOptions): Promise<ClaudeExecutionResult<T>> {
  const claudePath = process.env.CLAUDE_PATH || findClaudePath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args = ['-p'];

  if (options.resumeSessionId) {
    args.push('-r', options.resumeSessionId);
  }

  args.push('--output-format', 'json');

  if (options.jsonSchema) {
    args.push('--json-schema', JSON.stringify(options.jsonSchema));
  }

  if (options.appendSystemPrompt) {
    args.push('--append-system-prompt', options.appendSystemPrompt);
  }

  if (options.addDirs && options.addDirs.length > 0) {
    for (const dir of options.addDirs) {
      args.push('--add-dir', dir);
    }
  }

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
      let parsedOutput: unknown;
      let rawResult: unknown = '';
      let hasResult = false;
      let sessionId: string | undefined;
      try {
        ({ parsedOutput, rawResult, hasResult, sessionId } = extractClaudeOutput(stdout));
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

      // Validate parsed output against jsonSchema before resolving
      if (options.jsonSchema) {
        const schemaErrors = validateAgainstSchema(
          parsedOutput,
          options.jsonSchema as Record<string, unknown>,
        );
        if (schemaErrors.length > 0) {
          if (options.schemaFallbackMode === 'result_or_empty') {
            resolve({
              output: ((hasResult ? rawResult : '') ?? '') as T,
              rawStdout: stdout,
              usedSchemaFallback: true,
              schemaValidationErrors: schemaErrors,
              sessionId,
              exitCode,
              stderr,
              durationMs,
            });
            return;
          }

          reject(new ClaudeSchemaValidationError(
            `Claude output does not match expected schema: ${schemaErrors.join('; ')}`,
            stdout,
            schemaErrors,
            stderr,
            exitCode,
            durationMs,
          ));
          return;
        }
      }

      resolve({
        output: parsedOutput as T,
        rawStdout: stdout,
        sessionId,
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
