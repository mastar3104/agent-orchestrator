import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { parse, stringify } from 'yaml';

export async function readYaml<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  return parse(content) as T;
}

export async function writeYaml<T>(filePath: string, data: T): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const content = stringify(data, {
    indent: 2,
    lineWidth: 0,
  });
  await writeFile(filePath, content, 'utf-8');
}

export async function readYamlSafe<T>(filePath: string): Promise<T | null> {
  try {
    return await readYaml<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function parseYaml<T>(content: string): T {
  return parse(content) as T;
}

export function stringifyYaml<T>(data: T): string {
  return stringify(data, {
    indent: 2,
    lineWidth: 0,
  });
}
