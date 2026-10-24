import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { importDataset } from '../src/db/import-data.js';

const datasetPath = fileURLToPath(new URL('../../../data/dataset.json', import.meta.url));
const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('dataset import', () => {
  it('uses stable airport IDs, preserves locators, records checksums, and is idempotent', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const first = importDataset(db, datasetPath);
    expect(first.accepted).toMatchObject({ airports: 8, monthly: 192, weather: 192, rules: 12 });
    expect(db.prepare("SELECT id FROM airports WHERE name = '云川国际机场'").get()).toEqual({ id: 'A001' });
    expect(db.prepare("SELECT record_locator FROM airport_monthly WHERE airport_id = 'A001' ORDER BY month LIMIT 1").get()).toEqual({ record_locator: '01_机场月度运行基线!2' });
    expect(db.prepare("SELECT published_at FROM sources WHERE id = 'SIM-BASE'").get()).toEqual({ published_at: '2026-10-07T00:00:00+08:00' });
    expect(db.prepare('SELECT dataset_sha256 FROM dataset_imports').all()).toHaveLength(1);

    const second = importDataset(db, datasetPath);
    expect(second.accepted).toEqual({ airports: 0, sources: 0, monthly: 0, annual: 0, weather: 0, rules: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM airport_monthly').get()).toEqual({ count: 192 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM dataset_imports').get()).toEqual({ count: 1 });
    db.close();
  });

  it('rejects invalid calendar months and out-of-range weather units', () => {
    const directory = mkdtempSync(join(tmpdir(), 'flightguard-import-'));
    directories.push(directory);
    const value = JSON.parse(readFileSync(datasetPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, Array<Record<string, string>>>;
    value['01_机场月度运行基线']![0]!['月份'] = '13';
    value['03_机场天气月度']![0]!['最大风速（米/秒）'] = '999';
    const invalidPath = join(directory, 'invalid-dataset.json');
    writeFileSync(invalidPath, JSON.stringify(value));

    const db = openDatabase(':memory:');
    migrate(db);
    const report = importDataset(db, invalidPath);
    expect(report.rejected.map((item) => item.table)).toEqual(expect.arrayContaining(['airport_monthly', 'weather_monthly']));
    expect(db.prepare('SELECT COUNT(*) AS count FROM airport_monthly').get()).toEqual({ count: 191 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM weather_monthly').get()).toEqual({ count: 191 });
    db.close();
  });
});
