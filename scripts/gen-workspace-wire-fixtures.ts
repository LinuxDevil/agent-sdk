import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateWireFixtures } from '../src/workspaces/client/__fixtures__/generate';

writeFileSync(join(__dirname, '..', 'src', 'workspaces', 'client', '__fixtures__', 'wire.fixtures.json'), generateWireFixtures());
