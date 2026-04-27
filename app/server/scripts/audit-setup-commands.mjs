import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

const dataDir = join(process.cwd(), 'data');
const repositoriesPath = join(dataDir, 'repositories.yaml');
const itemsPath = join(dataDir, 'items');
const matches = [];

function collectCommands(filePath, owner, field, commands) {
  if (!Array.isArray(commands)) {
    return;
  }

  commands.forEach((command, index) => {
    if (typeof command === 'string' && /\byarn\b/.test(command)) {
      matches.push({
        filePath,
        owner,
        field,
        index,
        command,
      });
    }
  });
}

async function scanYamlFile(filePath, visitor) {
  if (!existsSync(filePath)) {
    return;
  }

  const raw = await readFile(filePath, 'utf8');
  const data = YAML.parse(raw);
  await visitor(data);
}

await scanYamlFile(repositoriesPath, async (repositories) => {
  if (!Array.isArray(repositories)) {
    return;
  }

  repositories.forEach((repository, index) => {
    const owner = repository?.name || repository?.id || `repository[${index}]`;
    collectCommands(repositoriesPath, owner, 'setup', repository?.setup);
    collectCommands(repositoriesPath, owner, 'hooks', repository?.hooks);
  });
});

if (existsSync(itemsPath)) {
  const itemEntries = await readdir(itemsPath, { withFileTypes: true });
  for (const itemEntry of itemEntries) {
    if (!itemEntry.isDirectory()) {
      continue;
    }

    const itemId = itemEntry.name;
    const itemConfigPath = join(itemsPath, itemId, 'item.yaml');
    await scanYamlFile(itemConfigPath, async (itemConfig) => {
      const repositories = itemConfig?.repositories;
      if (!Array.isArray(repositories)) {
        return;
      }

      repositories.forEach((repository, index) => {
        const owner = `${itemId}:${repository?.name || `repository[${index}]`}`;
        collectCommands(itemConfigPath, owner, 'setup', repository?.setup);
        collectCommands(itemConfigPath, owner, 'hooks', repository?.hooks);
      });
    });
  }
}

if (matches.length === 0) {
  console.log('No yarn-based setup or hook commands were found in data/.');
  process.exit(0);
}

console.log('Found yarn-based setup or hook commands:');
for (const match of matches) {
  console.log(`- ${match.owner} ${match.field}[${match.index}] @ ${match.filePath}`);
  console.log(`  ${match.command}`);
}
