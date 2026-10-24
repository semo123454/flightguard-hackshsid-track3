import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FlightGuardDb } from './connection.js';

type DataRow = Record<string, string>;
type Dataset = Record<string, DataRow[]>;

export interface ImportReport {
  datasetSha256: string;
  accepted: { airports: number; sources: number; monthly: number; annual: number; weather: number; rules: number };
  rejected: Array<{ table: string; row: number; reason: string }>;
  missing: string[];
  duplicate: number;
}

const numberOrNull = (value: string | undefined) => value === undefined || value === '' ? null : Number(value);

const seededAirportIds: Record<string, string> = {
  '云川国际机场': 'A001',
  '海陵国际机场': 'A002',
  '北岭机场': 'A003',
  '星湖机场': 'A004',
  '南湾机场': 'A005',
  '青岚机场': 'A006',
  '临江机场': 'A007',
  '高原机场': 'A008',
};

export function importDataset(db: FlightGuardDb, datasetPath: string): ImportReport {
  const raw = readFileSync(datasetPath, 'utf8').replace(/^\uFEFF/, '');
  const dataset = JSON.parse(raw) as Dataset;
  const report: ImportReport = {
    datasetSha256: createHash('sha256').update(raw).digest('hex'),
    accepted: { airports: 0, sources: 0, monthly: 0, annual: 0, weather: 0, rules: 0 },
    rejected: [],
    missing: [],
    duplicate: 0,
  };
  const monthly = dataset['01_机场月度运行基线'] || [];
  const annual = dataset['02_机场年度规模'] || [];
  const weather = dataset['03_机场天气月度'] || [];
  const sources = dataset['10_数据来源登记'] || [];
  const rules = dataset['05_运营规则'] || [];
  for (const [name, rows] of [
    ['01_机场月度运行基线', monthly],
    ['02_机场年度规模', annual],
    ['03_机场天气月度', weather],
    ['05_运营规则', rules],
    ['10_数据来源登记', sources],
  ] as const) if (!rows.length) report.missing.push(name);

  const airportNames = [...new Set(monthly.map((row) => row['机场名称']).filter((name): name is string => Boolean(name)))];
  const airportIds = new Map(airportNames.map((name) => [name, stableAirportId(name)]));
  const airportCategories = new Map(monthly.map((row) => [row['机场名称'], row['机场分类']]));

  const insertAirport = db.prepare('INSERT OR IGNORE INTO airports(id, name, category, aliases_json) VALUES (?, ?, ?, ?)');
  const insertSource = db.prepare(`INSERT OR IGNORE INTO sources(id, title, published_at, coverage, verification, simulated, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertMonthly = db.prepare(`INSERT OR IGNORE INTO airport_monthly
    (airport_id, month, completion_ratio, release_normal_ratio, source_id, record_locator) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertAnnual = db.prepare(`INSERT OR IGNORE INTO airport_annual
    (airport_id, year, passenger_volume, movements, importance, source_id, record_locator) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertWeather = db.prepare(`INSERT OR IGNORE INTO weather_monthly
    (airport_id, month, precipitation_mm, mean_temperature_c, max_wind_speed_mps, adverse_weather_days, missing_flag, source_id, record_locator)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertRule = db.prepare(`INSERT OR IGNORE INTO rules
    (id, version, description, action_text, human_approval_required, metadata_json) VALUES (?, '1.0', ?, ?, ?, ?)`);
  const insertImport = db.prepare(`INSERT OR IGNORE INTO dataset_imports(dataset_sha256, source_path, report_json, imported_at)
    VALUES (?, ?, ?, ?)`);

  const run = db.transaction(() => {
    airportNames.forEach((name) => {
      const result = insertAirport.run(airportIds.get(name), name, airportCategories.get(name) || '未分类', JSON.stringify([name]));
      result.changes ? report.accepted.airports++ : report.duplicate++;
    });
    sources.forEach((row, index) => {
      try {
        if (!row['来源编号']) throw new Error('来源编号为空');
        const result = insertSource.run(
          row['来源编号'], row['资料名称'] || row['来源编号'], normalizePublishedAt(row['发布日期']), row['数据所属期间'] || null,
          row['复核状态'] === '已复核' ? 'verified' : 'unverified', row['来源类型'] === '模拟数据' ? 1 : 0,
          JSON.stringify({ organization: row['发布机构'], link: row['网页链接'], locator: `10_数据来源登记!${index + 2}` }),
        );
        result.changes ? report.accepted.sources++ : report.duplicate++;
      } catch (error) { report.rejected.push({ table: 'sources', row: index + 2, reason: String(error) }); }
    });
    for (const internal of [
      ['HUMAN-CONFIRMED', '经复核人员确认的补充事实', 'verified'],
      ['SYSTEM-CALC', 'FlightGuard 确定性计算结果', 'verified'],
      ['RULESET-1.0', 'FlightGuard 规则集 1.0', 'verified'],
      ['EVENT-INPUT', '尚未核验的事件输入', 'unverified'],
    ] as const) {
      const result = insertSource.run(internal[0], internal[1], null, null, internal[2], 1, JSON.stringify({ internal: true }));
      result.changes ? report.accepted.sources++ : report.duplicate++;
    }
    monthly.forEach((row, index) => {
      try {
        const airportName = requiredString(row['机场名称'], '机场名称');
        const month = monthOf(row);
        const completion = Number(row['按计划完成航班的比例']);
        const release = Number(row['机场放行正常比例']);
        if (![completion, release].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error('比例超出 0—1');
        const result = insertMonthly.run(airportIds.get(airportName), month, completion, release, row['来源编号'], `01_机场月度运行基线!${index + 2}`);
        result.changes ? report.accepted.monthly++ : report.duplicate++;
      } catch (error) { report.rejected.push({ table: 'airport_monthly', row: index + 2, reason: String(error) }); }
    });
    annual.forEach((row, index) => {
      try {
        const airportName = requiredString(row['机场名称'], '机场名称');
        const year = integerInRange(row['年份'], 1900, 2100, '年份');
        const passengerVolume = nonNegativeOrNull(row['旅客吞吐量（万人次）'], '旅客吞吐量');
        const movements = nonNegativeOrNull(row['飞机起降架次'], '飞机起降架次');
        const result = insertAnnual.run(airportIds.get(airportName), year, passengerVolume, movements, row['航空公司业务重要程度'] || null, row['来源编号'], `02_机场年度规模!${index + 2}`);
        result.changes ? report.accepted.annual++ : report.duplicate++;
      } catch (error) { report.rejected.push({ table: 'airport_annual', row: index + 2, reason: String(error) }); }
    });
    weather.forEach((row, index) => {
      try {
        const airportName = requiredString(row['机场名称'], '机场名称');
        const month = monthOf(row);
        const missing = row['是否缺少数据'] === '是';
        const precipitation = rangedOrNull(row['降水量（毫米）'], 0, 10_000, '降水量（毫米）');
        const temperature = rangedOrNull(row['平均气温（摄氏度）'], -90, 60, '平均气温（摄氏度）');
        const wind = rangedOrNull(row['最大风速（米/秒）'], 0, 150, '最大风速（米/秒）');
        const adverseDays = rangedIntegerOrNull(row['明显不利天气天数'], 0, 31, '明显不利天气天数');
        if (!missing && [precipitation, temperature, wind, adverseDays].some((value) => value === null)) throw new Error('未标记缺失的天气记录包含空值');
        const result = insertWeather.run(airportIds.get(airportName), month, precipitation, temperature, wind, adverseDays, missing ? 1 : 0, row['来源编号'], `03_机场天气月度!${index + 2}`);
        result.changes ? report.accepted.weather++ : report.duplicate++;
      } catch (error) { report.rejected.push({ table: 'weather_monthly', row: index + 2, reason: String(error) }); }
    });
    rules.forEach((row, index) => {
      try {
        const result = insertRule.run(row['规则编号'], `${row['规则主题']}：${row['触发条件']}`, row['建议行动'], row['必须人工审批'] === '是' ? 1 : 0, JSON.stringify({ check: row['建议核查事项'], owner: row['建议升级对象'], prohibited: row['禁止自动执行事项'], locator: `05_运营规则!${index + 2}` }));
        result.changes ? report.accepted.rules++ : report.duplicate++;
      } catch (error) { report.rejected.push({ table: 'rules', row: index + 2, reason: String(error) }); }
    });
    insertImport.run(report.datasetSha256, datasetPath, JSON.stringify(report), new Date().toISOString());
  });
  run();
  return report;
}

function stableAirportId(name: string): string {
  return seededAirportIds[name] ?? `A-${createHash('sha256').update(name.trim()).digest('hex').slice(0, 10).toUpperCase()}`;
}

function monthOf(row: DataRow): string {
  const year = integerInRange(row['年份'], 1900, 2100, '年份');
  const month = integerInRange(row['月份'], 1, 12, '月份');
  return `${year}-${String(month).padStart(2, '0')}`;
}

function integerInRange(raw: string | undefined, minimum: number, maximum: number, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label}必须为 ${minimum}—${maximum} 的整数`);
  return value;
}

function rangedOrNull(raw: string | undefined, minimum: number, maximum: number, label: string): number | null {
  const value = numberOrNull(raw);
  if (value === null) return null;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label}超出 ${minimum}—${maximum}`);
  return value;
}

function rangedIntegerOrNull(raw: string | undefined, minimum: number, maximum: number, label: string): number | null {
  const value = rangedOrNull(raw, minimum, maximum, label);
  if (value !== null && !Number.isInteger(value)) throw new Error(`${label}必须为整数`);
  return value;
}

function nonNegativeOrNull(raw: string | undefined, label: string): number | null {
  return rangedOrNull(raw, 0, Number.MAX_SAFE_INTEGER, label);
}

function requiredString(raw: string | undefined, label: string): string {
  if (!raw?.trim()) throw new Error(`${label}不能为空`);
  return raw;
}

function normalizePublishedAt(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(raw)) return `${raw}T00:00:00+08:00`;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error('发布日期必须为 YYYY-MM-DD 或带时区的 ISO 时间');
  return raw;
}
