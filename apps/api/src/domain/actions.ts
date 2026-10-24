import type { Action } from '@flightguard/contracts';

export const actionCatalog = {
  stopAndVerify: (basisIds: string[]): Action => ({
    id: 'ACT-STOP-VERIFY', priority: 1, ownerRole: '运营负责人',
    text: '暂停确定性判断，核对冲突来源、更新时间和统计口径。', basisIds, requiresHumanReview: true,
  }),
  verifyOperations: (basisIds: string[]): Action => ({
    id: 'ACT-VERIFY-OPS', priority: 1, ownerRole: '运行协调人员',
    text: '核查前序运行、现场保障资源和后续任务集中程度。', basisIds, requiresHumanReview: true,
  }),
  monitor: (basisIds: string[]): Action => ({
    id: 'ACT-MONITOR', priority: 2, ownerRole: '运营分析人员',
    text: '持续监测指标和正式运行状态，并记录下一次更新时间。', basisIds, requiresHumanReview: false,
  }),
  prepareDrafts: (basisIds: string[]): Action => ({
    id: 'ACT-PREPARE-DRAFTS', priority: 3, ownerRole: '旅客服务负责人',
    text: '准备三类沟通草案；发布前必须由相应负责人审核。', basisIds, requiresHumanReview: true,
  }),
} as const;
