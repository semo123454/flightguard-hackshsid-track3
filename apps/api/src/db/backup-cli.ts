import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { openDatabase } from './connection.js';

const config = loadConfig();
if (config.databasePath === ':memory:') throw new Error('内存数据库无法备份');
const backupDir = join(config.projectRoot, 'runtime', 'backups');
mkdirSync(backupDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(backupDir, `flightguard-${timestamp}.sqlite`);
const db = openDatabase(config.databasePath);
try {
  await db.backup(destination);
  console.log(`SQLite 在线备份完成：${destination}`);
} finally { db.close(); }
