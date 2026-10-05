/**
 * 全局响应式状态（Vue 自带 reactive / computed，不引入 Pinia）+ IndexedDB 持久化。
 * 数据只写在本机浏览器，没有任何服务端请求。
 */
import { computed, reactive, toRaw } from 'vue'
import type { Project, ProjectKind, SizeRule, TrialAdoption, TrialParams } from './types'
import { BUILTIN_RULES, DEFAULT_RULE_VERSION, ruleByVersion } from './sizeRules'
import { runMerge } from './merge'
import {
  buildTrialRule,
  buildTrialRuleLabel,
  buildTrialVersion,
  trialBaseFingerprint,
  TRIAL_POLICY_TEXT,
  type TrialArchive
} from './trial'
import {
  STORE_META,
  STORE_PROJECTS,
  STORE_RULES,
  STORE_TRIALS,
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  type MetaEntry
} from './idb'

export type AppStore = {
  ready: boolean
  error: string
  projects: Project[]
  rules: SizeRule[]
  operator: string
}

export const store = reactive<AppStore>({
  ready: false,
  error: '',
  projects: [],
  rules: [...BUILTIN_RULES],
  operator: '现场录入员'
})

export const ruleVersions = computed(() => store.rules.map((rule) => rule.version))

const persistTimers = new Map<string, number>()

function sortProjects(): void {
  store.projects.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function initStore(): Promise<void> {
  try {
    const [projects, rules, meta] = await Promise.all([
      idbGetAll<Project>(STORE_PROJECTS),
      idbGetAll<SizeRule>(STORE_RULES),
      idbGetAll<MetaEntry>(STORE_META)
    ])
    const customRules = rules.filter((rule) => !rule.builtin)
    store.rules = [...BUILTIN_RULES, ...customRules].sort((a, b) =>
      a.effectiveFrom === b.effectiveFrom
        ? a.version.localeCompare(b.version)
        : a.effectiveFrom.localeCompare(b.effectiveFrom)
    )
    const missingBuiltin = BUILTIN_RULES.filter(
      (builtin) => !rules.some((rule) => rule.version === builtin.version)
    )
    if (missingBuiltin.length > 0) {
      for (const rule of missingBuiltin) await idbPut(STORE_RULES, rule)
    }
    // 旧版本（v1 库）建的项目没有试算留痕字段，读入时补齐，避免页面各处判空
    for (const project of projects) {
      if (project.trialAdoption === undefined) project.trialAdoption = null
    }
    store.projects = projects
    sortProjects()
    const operator = meta.find((entry) => entry.key === 'operator')
    if (operator) store.operator = operator.value
    store.ready = true
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
    store.ready = true
  }
}

export function getProject(id: string | string[]): Project | undefined {
  const key = Array.isArray(id) ? id[0] : id
  return store.projects.find((project) => project.id === key)
}

export function getRule(version: string): SizeRule {
  return ruleByVersion(store.rules, version)
}

export function projectsUsingRule(version: string): Project[] {
  return store.projects.filter((project) => project.ruleVersion === version)
}

export function isRuleInUse(version: string): boolean {
  return projectsUsingRule(version).length > 0
}

export function makeProjectId(): string {
  return `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

export async function createProject(input: {
  name: string
  kind: ProjectKind
  batches: string[]
  ruleVersion: string
}): Promise<Project> {
  const now = Date.now()
  const project: Project = {
    id: makeProjectId(),
    name: input.name.trim(),
    kind: input.kind,
    ruleVersion: input.ruleVersion || DEFAULT_RULE_VERSION,
    trialAdoption: null,
    batches: input.batches.length > 0 ? input.batches : [],
    persons: [],
    imports: [],
    createdAt: now,
    updatedAt: now
  }
  store.projects.unshift(project)
  await idbPut(STORE_PROJECTS, toRaw(project))
  return project
}

/**
 * 归并前的准备：按项目锁定版本执行归并（幂等），并记录本次耗时。
 * 结果始终来自项目锁定的规则版本，规则改版不会改变既有项目结果。
 */
export function ensureMerged(project: Project): number {
  const rule = getRule(project.ruleVersion)
  const result = runMerge(project, rule)
  project.perf = { ...(project.perf ?? {}), mergeMs: result.durationMs, mergeCount: project.persons.length }
  return result.durationMs
}

/** 保存项目：默认合并短时间内的连续写入，避免连续录入时频繁落盘 */
export function persistProject(project: Project, immediate = false): void {
  project.updatedAt = Date.now()
  if (!store.projects.some((item) => item.id === project.id)) store.projects.unshift(project)
  sortProjects()
  const pending = persistTimers.get(project.id)
  if (pending) window.clearTimeout(pending)
  if (immediate) {
    persistTimers.delete(project.id)
    void idbPut(STORE_PROJECTS, toRaw(project))
    return
  }
  const timer = window.setTimeout(() => {
    persistTimers.delete(project.id)
    void idbPut(STORE_PROJECTS, toRaw(project))
  }, 180)
  persistTimers.set(project.id, timer)
}

/** 立即落盘（导出、离开页面前调用），保证离线数据完整 */
export async function flushProject(project: Project): Promise<void> {
  const pending = persistTimers.get(project.id)
  if (pending) {
    window.clearTimeout(pending)
    persistTimers.delete(project.id)
  }
  project.updatedAt = Date.now()
  await idbPut(STORE_PROJECTS, toRaw(project))
  if (!store.projects.some((item) => item.id === project.id)) store.projects.unshift(project)
  sortProjects()
}

export async function deleteProject(id: string): Promise<void> {
  store.projects = store.projects.filter((project) => project.id !== id)
  await Promise.all([idbDelete(STORE_PROJECTS, id), idbDelete(STORE_TRIALS, id)])
}

export async function saveRule(rule: SizeRule): Promise<void> {
  const index = store.rules.findIndex((item) => item.version === rule.version)
  if (index >= 0) store.rules[index] = rule
  else store.rules.push(rule)
  store.rules.sort((a, b) =>
    a.effectiveFrom === b.effectiveFrom
      ? a.version.localeCompare(b.version)
      : a.effectiveFrom.localeCompare(b.effectiveFrom)
  )
  await idbPut(STORE_RULES, toRaw(rule))
}

export async function deleteRule(version: string): Promise<void> {
  store.rules = store.rules.filter((rule) => rule.version !== version)
  await idbDelete(STORE_RULES, version)
}

export async function setOperator(name: string): Promise<void> {
  store.operator = name
  await idbPut<MetaEntry>(STORE_META, { key: 'operator', value: name })
}

/* ------------------------------- 档位方案试算 ------------------------------- */

export async function getTrialArchive(projectId: string): Promise<TrialArchive | null> {
  try {
    const entry = await idbGet<TrialArchive>(STORE_TRIALS, projectId)
    return entry ?? null
  } catch {
    return null
  }
}

/**
 * 试算过程留档（每项目一份，重开页面还在）：只存最近一次试算的选项与全套对照表。
 * 已采纳信息在重新试算时保留，旧对照表因此仍能标出「选中的那一套」。
 */
export async function saveTrialArchive(
  project: Project,
  draft: {
    baseRuleVersion: string
    options: TrialArchive['options']
    schemes: TrialArchive['schemes']
    recommendedKey: string | null
    recommendReason: string
    policyText: string
    durationMs: number
  }
): Promise<TrialArchive> {
  const previous = await getTrialArchive(project.id)
  const now = Date.now()
  const archive: TrialArchive = {
    id: previous?.id ?? `trial_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    projectId: project.id,
    projectName: project.name,
    createdAt: previous?.createdAt ?? now,
    baseRuleVersion: draft.baseRuleVersion,
    options: draft.options,
    schemes: draft.schemes,
    recommendedKey: draft.recommendedKey,
    recommendReason: draft.recommendReason,
    policyText: draft.policyText,
    durationMs: draft.durationMs,
    adoptedKey: previous?.adoptedKey ?? null,
    adoptedAt: previous?.adoptedAt ?? null,
    adoptedBy: previous?.adoptedBy ?? '',
    adoptedRuleVersion: previous?.adoptedRuleVersion ?? null
  }
  await idbPut(STORE_TRIALS, archive)
  return archive
}

export type AdoptionResult = { rule: SizeRule; adoption: TrialAdoption; archive: TrialArchive }

/**
 * 采纳选中的试算方案——这是唯一把试算参数写进规则内核的入口：
 * 1) 以项目当前基准规则为底，只覆盖四个档位参数，落一条自定义 SizeRule；
 * 2) 项目 ruleVersion 切到新版本并立即重算，随后页面 / 归并 / 导出全部读同一份结果；
 * 3) 试算留档回写采纳标记，重新打开仍能看到选中的是哪套。
 */
export async function adoptTrialScheme(project: Project, scheme: TrialArchive['schemes'][number]): Promise<AdoptionResult> {
  const baseRule = getRule(project.ruleVersion)
  const params: TrialParams = { ...scheme.params }
  const now = new Date()
  const fingerprint = trialBaseFingerprint(baseRule)
  // 同一基准规则 + 完全相同的四个参数，复用既有试算规则，避免规则库里堆出参数一致的 -2、-3
  const reusable = store.rules.find(
    (item) =>
      !item.builtin &&
      trialBaseFingerprint(item) === fingerprint &&
      item.heightStepCm === params.heightStepCm &&
      item.heightAnchor === params.heightAnchorCm &&
      item.chestStepCm === params.chestStepCm &&
      item.boundaryRule === params.boundaryRule
  )
  const version = reusable?.version ?? buildTrialVersion(params, store.rules.map((rule) => rule.version))
  const rule: SizeRule =
    reusable ?? {
      ...buildTrialRule(baseRule, params),
      version,
      label: buildTrialRuleLabel(params, now),
      builtin: false,
      effectiveFrom: now.toISOString().slice(0, 10),
      note: `由「${project.name}」档位试算采纳生成；基准规则 ${baseRule.version}；${TRIAL_POLICY_TEXT}`
    }
  if (!reusable) await saveRule(rule)

  const previous = await getTrialArchive(project.id)
  const adoption: TrialAdoption = {
    trialId: previous?.id ?? '',
    params,
    ruleVersion: version,
    ruleLabel: rule.label,
    adoptedAt: now.getTime(),
    by: store.operator,
    policyText: TRIAL_POLICY_TEXT,
    maxBuckets: previous?.options.maxBuckets ?? 0,
    bucketCount: scheme.bucketCount,
    totalStock: scheme.stockQty,
    totalPriceFen: scheme.stockPriceFen
  }
  project.trialAdoption = adoption
  project.ruleVersion = version
  ensureMerged(project)
  await flushProject(project)

  if (previous) {
    const archive: TrialArchive = {
      ...previous,
      adoptedKey: scheme.key,
      adoptedAt: adoption.adoptedAt,
      adoptedBy: adoption.by,
      adoptedRuleVersion: version
    }
    await idbPut(STORE_TRIALS, archive)
    return { rule, adoption, archive }
  }
  // 理论上不会发生：采纳前必须先跑过试算（留档已落盘）
  throw new Error('未找到试算留档，无法采纳；请先运行一次档位试算')
}