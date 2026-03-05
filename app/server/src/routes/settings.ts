import type { FastifyPluginAsync } from 'fastify';
import type { ApiResponse } from '@agent-orch/shared';
import { readFileSync, existsSync } from 'fs';
import { writeFile, rename, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import {
  validateRolesYaml,
  getRolesReadPath,
  getRolesLocalPath,
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
  // GET /api/settings/roles — read raw roles content (local if exists, otherwise base)
  fastify.get<{
    Reply: ApiResponse<{ content: string; isLocal: boolean }>;
  }>('/settings/roles', async (_request, reply) => {
    try {
      const readPath = getRolesReadPath();
      const content = readFileSync(readPath, 'utf-8');
      const isLocal = readPath === getRolesLocalPath();
      return reply.send({ success: true, data: { content, isLocal } });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `Failed to read roles: ${(err as Error).message}`,
      });
    }
  });

  // PUT /api/settings/roles — validate, save to roles.local.yaml, and reload
  fastify.put<{
    Body: { content: string };
    Reply: ApiResponse<{ content: string; isLocal: boolean }>;
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
        const localPath = getRolesLocalPath();
        const suffix = randomBytes(4).toString('hex');
        const tmpPath = `${localPath}.tmp.${suffix}`;
        const hasExisting = existsSync(localPath);
        let backupPath: string | null = null;

        if (hasExisting) {
          backupPath = `${localPath}.bak.${suffix}`;
          await rename(localPath, backupPath);
        }

        try {
          await writeFile(tmpPath, content, 'utf-8');
          await rename(tmpPath, localPath);
        } catch (writeErr) {
          if (backupPath) await rename(backupPath, localPath);
          try { await unlink(tmpPath); } catch { /* ignore */ }
          throw writeErr;
        }

        try {
          reloadRoles();
        } catch (reloadErr) {
          if (backupPath) {
            await rename(backupPath, localPath);
          } else {
            try { await unlink(localPath); } catch { /* ignore */ }
          }
          reloadRoles();
          throw reloadErr;
        }

        if (backupPath) {
          try { await unlink(backupPath); } catch { /* ignore */ }
        }
      });

      return reply.send({ success: true, data: { content, isLocal: true } });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `Failed to save roles: ${(err as Error).message}`,
      });
    }
  });

  // DELETE /api/settings/roles/local — remove local override, fall back to base
  fastify.delete<{
    Reply: ApiResponse<{ content: string; isLocal: boolean }>;
  }>('/settings/roles/local', async (_request, reply) => {
    try {
      const result = await withSaveLock(async () => {
        const localPath = getRolesLocalPath();

        if (!existsSync(localPath)) {
          return { found: false } as const;
        }

        const suffix = randomBytes(4).toString('hex');
        const backupPath = `${localPath}.bak.${suffix}`;
        await rename(localPath, backupPath);

        try {
          reloadRoles();
        } catch (reloadErr) {
          await rename(backupPath, localPath);
          throw reloadErr;
        }

        try { await unlink(backupPath); } catch { /* ignore */ }

        const content = readFileSync(getRolesReadPath(), 'utf-8');
        return { found: true, content } as const;
      });

      if (!result.found) {
        return reply.status(404).send({
          success: false,
          error: 'No local roles override exists',
        });
      }

      return reply.send({ success: true, data: { content: result.content, isLocal: false } });
    } catch (err) {
      return reply.status(500).send({
        success: false,
        error: `Failed to reset roles: ${(err as Error).message}`,
      });
    }
  });
};
