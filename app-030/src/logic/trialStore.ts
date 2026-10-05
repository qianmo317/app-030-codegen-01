/**
 * 档位试算记录的本机留档与方案采纳。
 * - 试算过程（全部候选）与选中的那一套写进 IndexedDB，重新打开还在；
 * - 采纳 = 用候选的四项档位参数生成新版本 SizeRule 写进规则内核，
 *   项目锁定新版本后，页面 / 归并 / 导出三处全部按同一份结果算。
 */
import { toRaw } from 'vue'
import type { Project, SizeRule, TrialRecord, TrialScheme } from './types'
import { STORE_TRIALS, STORE_RULES, idbGet, idbPut } from './idb'
import { buildVariantRule, paramsOfRule } from './trial'

export async function loadTrial(projectId: string): Promise<TrialRecord | null> {
  try {
    const record = await idbGet<TrialRecord>(STORE_TRIALS, projectId)
    return record ?? null
  } catch {
    return null
  }
}

export async function saveTrial(record: TrialRecord): Promise<void> {
  await idbPut(STORE_TRIALS, toRaw(record))
}

/** 生成不冲突的试算规则版本号：trial-1 / trial-2 … */
export function nextTrialVersion(existing: SizeRule[]): string {
  let index = 1
  while (existing.some((rule) => rule.version === `trial-${index}`)) index += 1
  return `trial-${index}`
}

export type AdoptResult = { rule: SizeRule; version: string }

/**
 * 把选中的试算方案写进规则内核：
 * 生成新版本规则（型别区间等沿用基础版本）并持久化，项目锁定到新版本，
 * 之后 runMerge / buildSummary / 导出全部读这份规则，不存在各处重算。
 */
export async function adoptTrialScheme(input: {
  project: Project
  baseRule: SizeRule
  scheme: TrialScheme
  record: TrialRecord
  version: string
  label: string
  effectiveFrom: string
  existingRules: SizeRule[]
}): Promise<AdoptResult> {
  const { project, baseRule, scheme, record, version, label, effectiveFrom, existingRules } = input
  const newRule: SizeRule = {
    ...buildVariantRule(baseRule, scheme.params),
    version,
    label: label.trim() || `试算采纳：${scheme.binCount} 档方案`,
    builtin: false,
    effectiveFrom: effectiveFrom || new Date().toISOString().slice(0, 10),
    note: `由项目「${project.name}」的档位试算采纳生成：${scheme.params.heightStepCm}cm 身高步长 / 起点 ${scheme.params.heightAnchorCm}cm / ${scheme.params.chestStepCm}cm 胸围步长。`
  }
  await idbPut(STORE_RULES, newRule)
  existingRules.push(newRule)

  project.ruleVersion = version
  record.selectedSchemeId = scheme.id
  record.selectedRuleVersion = version
  record.updatedAt = Date.now()
  await saveTrial(record)

  return { rule: newRule, version }
}

/** 项目当前锁定的规则正好是某套试算方案的参数时，标记它为留档里的选中方案（重开后回显用） */
export function matchSelectedScheme(record: TrialRecord, rule: SizeRule): string | null {
  const params = paramsOfRule(rule)
  const matched = record.schemes.find((scheme) => {
    const p = scheme.params
    return (
      p.heightStepCm === params.heightStepCm &&
      p.heightAnchorCm === params.heightAnchorCm &&
      p.chestStepCm === params.chestStepCm &&
      p.boundaryRule === params.boundaryRule
    )
  })
  return matched?.id ?? null
}
