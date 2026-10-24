import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';
import { importDataset } from './import-data.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  migrate(db);
  const report = importDataset(db, join(config.projectRoot, 'data', 'dataset.json'));
  const outputDir = join(config.projectRoot, 'data', 'normalized');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'import-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
