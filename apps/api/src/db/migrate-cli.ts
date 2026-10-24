import { openDatabase } from './connection.js';
import { migrate } from './migrate.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
try {
  migrate(db);
  console.log(`数据库迁移完成：${config.databasePath}`);
} finally {
  db.close();
}
