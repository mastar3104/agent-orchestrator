import { appendFile, readFile, mkdir } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { dirname } from 'path';

export async function appendJsonl<T>(filePath: string, data: T): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const line = JSON.stringify(data) + '\n';
  await appendFile(filePath, line, 'utf-8');
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function* streamJsonl<T>(filePath: string): AsyncGenerator<T> {
  if (!existsSync(filePath)) {
    return;
  }

  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim().length > 0) {
      yield JSON.parse(line) as T;
    }
  }
}

export async function readLastN<T>(filePath: string, n: number): Promise<T[]> {
  const events = await readJsonl<T>(filePath);
  return events.slice(-n);
}

export async function countLines(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.trim().split('\n').filter((line) => line.length > 0).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}
