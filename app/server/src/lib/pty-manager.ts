import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { AgentRole } from '@agent-orch/shared';
import {
  classifyCommand,
  detectApprovalPrompt,
  detectApprovalUiKind,
  extractCommandFromPrompt,
  getBlocklistReason,
  type ApprovalClassification,
  type ApprovalUiKind,
} from './approval-engine';

export interface PtyOptions {
  id: string;
  itemId: string;
  role: AgentRole;
  workingDir: string;
  prompt: string;
  env?: Record<string, string>;
}

export interface PtyInstance {
  id: string;
  itemId: string;
  role: AgentRole;
  pty: pty.IPty;
  pid: number;
  outputBuffer: string;
  approvalState: 'none' | 'waiting' | 'sent';
  pendingCommand: string | null;
  pendingUiKind: ApprovalUiKind | null;
  approvalSentAt: number | null;
  approvalRetried: boolean;
}

export interface ApprovalRequest {
  instanceId: string;
  command: string;
  classification: ApprovalClassification;
  uiKind: ApprovalUiKind;
  context: string;
  timestamp: string;
}

export class PtyManager extends EventEmitter {
  private instances: Map<string, PtyInstance> = new Map();
  private outputBufferLimit = 16384; // Keep last 16KB of output
  private static readonly APPROVAL_TIMEOUT_MS = 3000; // 3秒タイムアウト
  private cachedClaudePath: string | null = null;

  private findClaudePath(): string {
    if (this.cachedClaudePath) {
      return this.cachedClaudePath;
    }

    // Common installation locations
    const possiblePaths = [
      join(homedir(), '.claude', 'local', 'claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      join(homedir(), '.local', 'bin', 'claude'),
    ];

    for (const p of possiblePaths) {
      if (existsSync(p)) {
        this.cachedClaudePath = p;
        return p;
      }
    }

    // Fallback to just 'claude' and hope it's in PATH
    return 'claude';
  }

  async spawn(options: PtyOptions): Promise<PtyInstance> {
    const claudePath = process.env.CLAUDE_PATH || this.findClaudePath();

    // --permission-mode acceptEdits: 編集操作（Write/Edit）を自動承認
    // 危険な操作（Bash/ネットワーク等）は引き続き承認が必要
    const ptyProcess = pty.spawn(claudePath, ['--permission-mode', 'acceptEdits', options.prompt], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.workingDir,
      env: {
        ...process.env,
        ...options.env,
        TERM: 'xterm-256color',
        FORCE_COLOR: '1',
      },
    });

    const instance: PtyInstance = {
      id: options.id,
      itemId: options.itemId,
      role: options.role,
      pty: ptyProcess,
      pid: ptyProcess.pid,
      outputBuffer: '',
      approvalState: 'none',
      pendingCommand: null,
      pendingUiKind: null,
      approvalSentAt: null,
      approvalRetried: false,
    };

    this.instances.set(options.id, instance);

    // Handle output
    ptyProcess.onData((data) => {
      this.handleOutput(instance, data);
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      this.emit('exit', {
        instanceId: options.id,
        exitCode,
        signal,
      });
      this.instances.delete(options.id);
    });

    this.emit('started', {
      instanceId: options.id,
      pid: ptyProcess.pid,
    });

    return instance;
  }

  private handleOutput(instance: PtyInstance, data: string): void {
    // Append to buffer first (before detection)
    instance.outputBuffer += data;
    if (instance.outputBuffer.length > this.outputBufferLimit) {
      instance.outputBuffer = instance.outputBuffer.slice(-this.outputBufferLimit);
    }

    // Emit output event
    this.emit('output', {
      instanceId: instance.id,
      data,
      timestamp: new Date().toISOString(),
    });

    // タスク完了検出（行単位完全一致で誤爆防止）
    const lines = data.split('\n');
    for (const line of lines) {
      if (line.trim() === 'TASKS_COMPLETED') {
        this.emit('tasks_completed', {
          instanceId: instance.id,
          timestamp: new Date().toISOString(),
        });
        break;
      }
    }

    // 承認UI消失の検出（送信後の確認）
    if (instance.approvalState === 'sent') {
      const now = Date.now();
      const elapsed = instance.approvalSentAt ? now - instance.approvalSentAt : 0;

      // 最新チャンク(data) OR バッファ末尾(tail) で承認UIの存在を確認
      const tail = instance.outputBuffer.slice(-2048);
      const uiStillPresent = detectApprovalPrompt(data) || detectApprovalPrompt(tail);

      if (!uiStillPresent) {
        // UI消失 → 正常完了
        this.resetApprovalState(instance);
      } else if (elapsed > PtyManager.APPROVAL_TIMEOUT_MS && !instance.approvalRetried) {
        // タイムアウト && リトライ未実施 → フォールバック応答を1回だけ試行
        instance.approvalRetried = true;
        // menuの場合は'1'でフォールバック、それ以外はEnterのみ
        const fallbackResponse = instance.pendingUiKind === 'menu' ? '1' : '';
        this.sendLine(instance.id, fallbackResponse);
      }
      return; // 送信済み状態では新しい検出をスキップ
    }

    // Check for approval prompts using accumulated buffer
    const approvalContext = detectApprovalPrompt(instance.outputBuffer);
    if (approvalContext && instance.approvalState === 'none') {
      const command = extractCommandFromPrompt(instance.outputBuffer) || approvalContext;
      const classification = classifyCommand(command);
      const uiKind = detectApprovalUiKind(instance.outputBuffer);

      instance.approvalState = 'waiting';
      instance.pendingCommand = command;
      instance.pendingUiKind = uiKind;

      if (classification === 'blocklist') {
        const reason = getBlocklistReason(command) || 'Command blocked by security policy';
        this.emit('approval_auto_denied', {
          instanceId: instance.id,
          command,
          reason,
        });

        // uiKindに応じた応答（unknownの場合は'3'を試す）
        const response = uiKind === 'yn' ? 'n' : '3';
        this.sendInputAndMarkSent(instance, response);

      } else if (classification === 'approval_required') {
        // unknownの場合も人間承認に倒す
        this.emit('approval_requested', {
          instanceId: instance.id,
          command,
          classification,
          uiKind,
          context: instance.outputBuffer.slice(-4096),
          timestamp: new Date().toISOString(),
        });
        // waiting状態を維持（人間の応答を待つ）

      } else {
        // Auto-approve
        this.emit('approval_auto_approved', {
          instanceId: instance.id,
          command,
        });

        // uiKindに応じた応答
        // menu: Enter優先（''）、フォールバックで'1'はリトライ時
        // yn: 'y'
        // unknown: Enterのみ
        let response: string;
        if (uiKind === 'menu') {
          response = '';  // Enter優先（選択済み状態でEnterを押す）
        } else if (uiKind === 'yn') {
          response = 'y';
        } else {
          response = '';  // unknown: Enterのみ送信
        }
        this.sendInputAndMarkSent(instance, response);
      }
    }
  }

  private sendInputAndMarkSent(instance: PtyInstance, input: string): void {
    this.sendLine(instance.id, input);
    instance.approvalState = 'sent';
    instance.approvalSentAt = Date.now();
    instance.approvalRetried = false;
  }

  private resetApprovalState(instance: PtyInstance): void {
    instance.approvalState = 'none';
    instance.pendingCommand = null;
    instance.pendingUiKind = null;
    instance.approvalSentAt = null;
    instance.approvalRetried = false;
  }

  sendInput(instanceId: string, input: string): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    instance.pty.write(input);
    return true;
  }

  sendLine(instanceId: string, input: string): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    instance.pty.write(input + '\r');
    return true;
  }

  processApproval(instanceId: string, approved: boolean, uiKind?: ApprovalUiKind): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.approvalState !== 'waiting') {
      return false;
    }

    // uiKindが指定されていない場合は保存されたものを使用
    const actualUiKind = uiKind || instance.pendingUiKind || detectApprovalUiKind(instance.outputBuffer);

    let response: string;
    if (actualUiKind === 'menu') {
      response = approved ? '' : '3';  // 承認: Enter優先、拒否: '3'
    } else if (actualUiKind === 'yn') {
      response = approved ? 'y' : 'n';
    } else {
      // unknown: Enterのみ送信（承認の場合）、拒否は'n'を試す
      response = approved ? '' : 'n';
    }

    this.sendInputAndMarkSent(instance, response);

    this.emit('approval_processed', {
      instanceId,
      approved,
    });

    return true;
  }

  resize(instanceId: string, cols: number, rows: number): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    instance.pty.resize(cols, rows);
    return true;
  }

  kill(instanceId: string): boolean {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      return false;
    }

    instance.pty.kill();
    this.instances.delete(instanceId);
    return true;
  }

  getInstance(instanceId: string): PtyInstance | undefined {
    return this.instances.get(instanceId);
  }

  getInstancesByItem(itemId: string): PtyInstance[] {
    return Array.from(this.instances.values()).filter(
      (instance) => instance.itemId === itemId
    );
  }

  getAllInstances(): PtyInstance[] {
    return Array.from(this.instances.values());
  }

  getOutputBuffer(instanceId: string): string | null {
    const instance = this.instances.get(instanceId);
    return instance?.outputBuffer ?? null;
  }
}

// Singleton instance
export const ptyManager = new PtyManager();
