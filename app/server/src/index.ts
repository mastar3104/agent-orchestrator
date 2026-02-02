import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdir } from 'fs/promises';

import { itemRoutes } from './routes/items';
import { agentRoutes } from './routes/agents';
import { approvalRoutes } from './routes/approval';
import { wsRoutes } from './routes/ws';
import { repositoryRoutes } from './routes/repositories';
import { getItemsDir, getDataDir } from './lib/paths';
import { cleanupOrphanedAgentsForItem } from './services/agent-service';
import { listItems } from './services/item-service';

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function cleanupOrphanedAgents(): Promise<void> {
  console.log('Checking for orphaned agents...');
  try {
    const items = await listItems();
    let totalCleaned = 0;

    for (const item of items) {
      const cleaned = await cleanupOrphanedAgentsForItem(item.id);
      totalCleaned += cleaned;
    }

    if (totalCleaned > 0) {
      console.log(`Cleaned up ${totalCleaned} orphaned agent(s)`);
    } else {
      console.log('No orphaned agents found');
    }
  } catch (error) {
    console.error('Failed to cleanup orphaned agents:', error);
    // Don't block startup on cleanup failure
  }
}

async function main() {
  // Ensure data directories exist
  await mkdir(getDataDir(), { recursive: true });
  await mkdir(getItemsDir(), { recursive: true });

  // Clean up orphaned agents from previous server session
  await cleanupOrphanedAgents();

  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // Register plugins
  await fastify.register(cors, {
    origin: true,
    credentials: true,
  });

  await fastify.register(websocket);

  // Register routes
  await fastify.register(itemRoutes, { prefix: '/api' });
  await fastify.register(agentRoutes, { prefix: '/api' });
  await fastify.register(approvalRoutes, { prefix: '/api' });
  await fastify.register(repositoryRoutes, { prefix: '/api' });
  await fastify.register(wsRoutes);

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // Start server
  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Server running at http://${HOST}:${PORT}`);
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

main();
