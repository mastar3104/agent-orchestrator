export type ApprovalClassification = 'blocklist' | 'approval_required' | 'auto_approve';

export type ApprovalUiKind = 'menu' | 'yn' | 'unknown';

export type ToolType = 'bash' | 'read' | 'write' | 'edit' | 'unknown';

export interface ParsedApprovalRequest {
  tool: ToolType;
  command?: string;           // bashの場合のコマンド
  path?: string;              // ファイルパス
  isOutsideWorkspace: boolean;
  isDestructive: boolean;     // rm, git reset --hard, etc.
  involvesSecrets: boolean;   // .env, credentials, etc.
  involvesNetwork: boolean;   // curl, wget, npm install, etc.
  rawPrompt: string;
}

// Dangerous commands that should be instantly denied
const BLOCKLIST_PATTERNS = [
  // Destructive recursive deletions
  /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive)\s+.*\//,
  /rm\s+-[a-zA-Z]*f[a-zA-Z]*r?\s+.*\//,
  /rm\s+-rf\s*\/(?!\S)/,
  /rm\s+-rf\s+\/\s*$/,

  // Fork bombs
  /:\(\)\{\s*:\|:&\s*\};:/,
  /\.\/\(:\(\)\{\s*:\|:&\s*\};:\)/,

  // Direct writes to critical system files
  />\s*\/etc\/passwd/,
  />\s*\/etc\/shadow/,
  /dd\s+.*of=\/dev\/(sda|hda|nvme)/,

  // chmod 777 on system directories
  /chmod\s+(-R\s+)?777\s+\//,

  // Destroy MBR
  /dd\s+.*of=\/dev\/(sda|hda|nvme)\s+.*bs=/,

  // Network-based attacks
  /nmap.*-sS/,

  // Cryptomining indicators
  /xmrig|minerd|cryptonight/i,
];

// Commands that require user approval
const APPROVAL_REQUIRED_PATTERNS = [
  // File deletion
  /\brm\b/,
  /\brmdir\b/,

  // Git operations that affect remote
  /\bgit\s+push\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+reset\s+--hard\b/,

  // Docker operations
  /\bdocker\s+rm\b/,
  /\bdocker\s+rmi\b/,
  /\bdocker\s+system\s+prune\b/,
  /\bdocker\s+run\b/,

  // Network operations
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b/,

  // Package management (can install arbitrary code)
  /\bnpm\s+(install|i)\s+[^-]/,
  /\byarn\s+add\b/,
  /\bpip\s+install\b/,
  /\bpip3\s+install\b/,
  /\bbrew\s+install\b/,
  /\bapt(-get)?\s+install\b/,

  // Process management
  /\bkill\b/,
  /\bkillall\b/,
  /\bpkill\b/,

  // System operations
  /\bsudo\b/,
  /\bsu\s+-?\s*$/,
  /\bchmod\b/,
  /\bchown\b/,

  // Database operations
  /DROP\s+(DATABASE|TABLE)/i,
  /DELETE\s+FROM/i,
  /TRUNCATE/i,

  // Environment modifications
  /\bexport\s+[A-Z_]+=.*\bPATH\b/,
  /\beval\b/,
  /\bexec\b/,
];

export function classifyCommand(command: string): ApprovalClassification {
  // Check blocklist first
  for (const pattern of BLOCKLIST_PATTERNS) {
    if (pattern.test(command)) {
      return 'blocklist';
    }
  }

  // Check approval required
  for (const pattern of APPROVAL_REQUIRED_PATTERNS) {
    if (pattern.test(command)) {
      return 'approval_required';
    }
  }

  // Auto-approve everything else
  return 'auto_approve';
}

export function getBlocklistReason(command: string): string | null {
  if (/rm\s+.*-rf\s*\//.test(command) || /rm\s+-rf\s+\//.test(command)) {
    return 'Recursive deletion of root directory';
  }
  if (/:\(\)\{/.test(command)) {
    return 'Fork bomb detected';
  }
  if (/>\s*\/etc\/(passwd|shadow)/.test(command)) {
    return 'Write to critical system file';
  }
  if (/dd\s+.*of=\/dev\//.test(command)) {
    return 'Direct device write';
  }
  if (/chmod\s+(-R\s+)?777\s+\//.test(command)) {
    return 'Dangerous permission change on system directory';
  }
  return null;
}

// Patterns to detect approval prompts from Claude
const APPROVAL_PROMPT_PATTERNS = [
  // Common patterns from Claude Code
  /Do you want to proceed\?/i,
  /Do you want to overwrite/i,
  /Allow this command\?/i,
  /\[y\/n\]/i,
  /\[Y\/n\]/i,
  /\[yes\/no\]/i,
  /Press Enter to continue/i,
  /Continue\?/i,
  /Proceed\?/i,
  /Are you sure\?/i,

  // Bash tool approval patterns
  /Allow Bash:/i,
  /Allow command:/i,

  // File operation patterns
  /Allow Write:/i,
  /Allow Edit:/i,
  /Allow Read:/i,

  // Interactive menu patterns (numbered choices)
  /❯\s*\d+\.\s*(Yes|No)/i,
];

export function detectApprovalPrompt(output: string): string | null {
  for (const pattern of APPROVAL_PROMPT_PATTERNS) {
    const match = output.match(pattern);
    if (match) {
      // Try to extract the command being requested
      // Look for common patterns like "Allow Bash: <command>"
      const commandMatch = output.match(/(?:Allow\s+(?:Bash|command):?\s*)([^\n]+)/i);
      if (commandMatch) {
        return commandMatch[1].trim();
      }

      // Return the matched portion as context
      return match[0];
    }
  }
  return null;
}

export function detectApprovalUiKind(output: string): ApprovalUiKind {
  // Menu形式: 番号選択 (❯ 1. Yes / 2. Yes, and... / 3. No)
  if (/❯\s*\d+\.\s*(Yes|No)/i.test(output)) {
    return 'menu';
  }
  // y/n形式: [y/n], [Y/n], [yes/no] など
  if (/\[y\/n\]/i.test(output) || /\[yes\/no\]/i.test(output)) {
    return 'yn';
  }
  // 判定不能の場合
  return 'unknown';
}

export function extractCommandFromPrompt(output: string): string | null {
  // Try to extract command from various prompt formats
  const patterns = [
    /Allow Bash:\s*`([^`]+)`/i,
    /Allow command:\s*`([^`]+)`/i,
    /Run:\s*`([^`]+)`/i,
    /Execute:\s*`([^`]+)`/i,
    /\$ ([^\n]+)/,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

// Patterns for detecting secrets access
const SECRETS_PATTERNS = [
  /\.env$/,
  /\.env\./,
  /credentials/i,
  /secrets?/i,
  /\.pem$/,
  /\.key$/,
  /password/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /\.ssh\//,
];

// Patterns for network operations
const NETWORK_PATTERNS = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bnpm\s+(install|i|publish)\b/,
  /\byarn\s+(add|publish)\b/,
  /\bpip\s+install\b/,
  /\bgit\s+(push|fetch|pull|clone)\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b/,
  /\bdocker\s+(push|pull)\b/,
];

// Patterns for destructive operations
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*|--recursive)/,
  /\brm\s+-rf\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f/,
  /\bgit\s+checkout\s+\./,
  /DROP\s+(DATABASE|TABLE)/i,
  /DELETE\s+FROM/i,
  /TRUNCATE/i,
  /\bchmod\s+(-R\s+)?[0-7]{3,4}\b/,
];

function detectTool(output: string): ToolType {
  if (/Allow Bash:/i.test(output) || /Allow command:/i.test(output)) {
    return 'bash';
  }
  if (/Allow Write:/i.test(output)) {
    return 'write';
  }
  if (/Allow Edit:/i.test(output)) {
    return 'edit';
  }
  if (/Allow Read:/i.test(output)) {
    return 'read';
  }
  return 'unknown';
}

function extractPath(output: string): string | null {
  // Try to extract file path from various prompt formats
  const patterns = [
    /Allow (?:Write|Edit|Read):\s*`?([^`\n]+)`?/i,
    /File:\s*`?([^`\n]+)`?/i,
    /Path:\s*`?([^`\n]+)`?/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

function isOutsideWorkspace(path: string | null, workspaceDir?: string): boolean {
  if (!path) return false;

  // Check for obvious workspace escape patterns
  if (path.startsWith('/etc/')) return true;
  if (path.startsWith('/usr/')) return true;
  if (path.startsWith('/var/')) return true;
  if (path.includes('/.ssh/')) return true;
  if (path.startsWith('~')) return true;
  if (path.includes('/../') || path.startsWith('../')) return true;

  // If workspace dir is provided, check if path is within it
  if (workspaceDir && path.startsWith('/')) {
    const normalizedWorkspace = workspaceDir.replace(/\/$/, '');
    if (!path.startsWith(normalizedWorkspace + '/') && path !== normalizedWorkspace) {
      return true;
    }
  }

  return false;
}

function involvesSecrets(content: string): boolean {
  return SECRETS_PATTERNS.some((pattern) => pattern.test(content));
}

function involvesNetwork(command: string): boolean {
  return NETWORK_PATTERNS.some((pattern) => pattern.test(command));
}

function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

export function parseClaudeApprovalRequest(
  output: string,
  workspaceDir?: string
): ParsedApprovalRequest | null {
  // Check if this looks like an approval prompt
  if (!detectApprovalPrompt(output)) {
    return null;
  }

  const tool = detectTool(output);
  const command = extractCommandFromPrompt(output);
  const path = extractPath(output);

  const contentToCheck = command || path || output;

  return {
    tool,
    command: command ?? undefined,
    path: path ?? undefined,
    isOutsideWorkspace: isOutsideWorkspace(path || command, workspaceDir),
    isDestructive: command ? isDestructive(command) : false,
    involvesSecrets: involvesSecrets(contentToCheck),
    involvesNetwork: command ? involvesNetwork(command) : false,
    rawPrompt: output,
  };
}

export function requiresHumanApproval(parsed: ParsedApprovalRequest): boolean {
  return (
    parsed.isOutsideWorkspace ||
    parsed.isDestructive ||
    parsed.involvesSecrets ||
    parsed.involvesNetwork
  );
}
