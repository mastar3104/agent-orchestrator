import type { FastifyPluginAsync } from 'fastify';
import type { ApiResponse } from '@agent-orch/shared';
import { readFileSync } from 'fs';
import { writeFile, rename, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import {
  validateRolesYaml,
  getRolesConfigPath,
  reloadRoles,
} from '../lib/role-loader';

// ─── Concurrency: serialize PUTs with a simple promise chain ───

let saveLock: Promise<void> = Promise.resolve();

function withSaveLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = saveLock;
  let resolve: () => void;
  saveLock = new Promise<void>((r) => {
    resolve = r;
  });
  return prev.then(fn).finally(() => resolve!());
}

// ─── Routes ───

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/settings/roles — read raw roles.yaml content
  fastify.get<{
    Reply: ApiResponse<{ content: string }>;
  }>('/settings/roles', async (_request, reply) => {
    try {
      const configPath = getRolesConfigPath();
      const content = readFileSync(configPath, 'utf-8');
      return reply.send({ success: true, data: { content } });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `Failed to read roles.yaml: ${(err as Error).message}`,
      });
    }
  });

  // PUT /api/settings/roles — validate, save, and reload roles.yaml
  fastify.put<{
    Body: { content: string };
    Reply: ApiResponse<{ content: string }>;
  }>('/settings/roles', async (request, reply) => {
    // Input validation
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { content } = body;

    if (typeof content !== 'string') {
      return reply.status(400).send({
        success: false,
        error: 'content must be a non-empty string',
      });
    }

    if (content.trim() === '') {
      return reply.status(400).send({
        success: false,
        error: 'content must not be empty',
      });
    }

    // YAML validation (before any disk I/O)
    try {
      validateRolesYaml(content);
    } catch (err) {
      return reply.status(400).send({
        success: false,
        error: (err as Error).message,
      });
    }

    // Atomic save with rollback
    try {
      await withSaveLock(async () => {
        const configPath = getRolesConfigPath();
        const suffix = randomBytes(4).toString('hex');
        const tmpPath = `${configPath}.tmp.${suffix}`;
        const backupPath = `${configPath}.bak.${suffix}`;

        // Backup current file
        await rename(configPath, backupPath);

        try {
          // Write new content atomically
          await writeFile(tmpPath, content, 'utf-8');
          await rename(tmpPath, configPath);
        } catch (writeErr) {
          // Restore backup if write/rename fails
          await rename(backupPath, configPath);
          try {
            await unlink(tmpPath);
          } catch {
            /* ignore */
          }
          throw writeErr;
        }

        try {
          reloadRoles();
        } catch (reloadErr) {
          // Atomic rollback: restore backup
          await rename(backupPath, configPath);
          throw reloadErr;
        }

        // Success — clean up backup
        try {
          await unlink(backupPath);
        } catch {
          /* ignore */
        }
      });

      return reply.send({ success: true, data: { content } });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `Failed to save roles.yaml: ${(err as Error).message}`,
      });
    }
  });
};
