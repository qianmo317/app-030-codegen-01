/**
 * 档位方案试算引擎（规格核心）。
 *
 * 唯一换算口径：档位对齐一律走 alignToStep 的半厘米整数运算，
 * 候选规则只是在 SizeRule 上覆盖「身高步长 / 身高起点 / 胸围步长 / 边界规则」四项，
 * 每套候选都走与正式排产完全相同的 runMerge + buildSummary，
 * 页面、归并、导出不许再各算一遍。
 */
import type {
  BoundaryRule,
  Project,
  SizeRule,
  TrialConfig,
  TrialGridConfig,
  TrialParams,
  TrialRecord,
  TrialScheme
} from './types'
import { cmToHalfUnits } from './precision'
import { buildSummary, runMerge, stockSuggestion } from './merge'

/** 试算网格的默认候选值 */
export const DEFAULT_TRIAL_GRID: TrialGridConfig = {
  heightStepsCm: [3, 4, 5],
  heightAnchorsCm: [153, 155],
  chestStepsCm: [2, 4],
  boundaryRules: ['round_up', 'nearest']
}

export const DEFAULT_MAX_BINS = 40
export const DEFAULT_UNIT_PRICE = 100
/** 笛卡尔积组合数上限，防止一次试算过多把页面卡住 */
export const MAX_COMBINATIONS = 240

export const BOUNDARY_TEXT: Record<BoundaryRule, string> = {
  round_up: '边界归上',
  nearest: '就近归下'
}

/** 参数指纹：全部换算成半厘米整数再拼接，不用小数直接比 */
export function schemeId(params: TrialParams): string {
  return [
    cmToHalfUnits(params.heightStepCm),
    cmToHalfUnits(params.heightAnchorCm),
    cmToHalfUnits(params.chestStepCm),
    params.boundaryRule === 'round_up' ? 'u' : 'n'
  ].join('-')
}

export function paramsEqual(a: TrialParams, b: TrialParams): boolean {
  return schemeId(a) === schemeId(b)
}

export function paramsOfRule(rule: SizeRule): TrialParams {
  return {
    heightStepCm: rule.heightStepCm,
    heightAnchorCm: rule.heightAnchor,
    chestStepCm: rule.chestStepCm,
    boundaryRule: rule.boundaryRule
  }
}

/** 在基础规则上覆盖四项档位参数，型别区间 / 特殊标记 / 可判定范围等全部沿用基础版本 */
export function buildVariantRule(base: SizeRule, params: TrialParams): SizeRule {
  return {
    ...base,
    heightStepCm: params.heightStepCm,
    heightAnchor: params.heightAnchorCm,
    chestStepCm: params.chestStepCm,
    boundaryRule: params.boundaryRule
  }
}

/** 解析逗号分隔的候选长度列表：必须是正数且为 0.5cm 的整数倍；返回去重升序结果与错误提示 */
export function parseHalfCmList(raw: string): { values: number[]; error: string } {
  const tokens = raw
    .split(/[,，、\s]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
  const values: number[] = []
  for (const token of tokens) {
    const value = Number(token)
    if (!Number.isFinite(value)) return { values: [], error: `「${token}」不是数字` }
    if (value <= 0) return { values: [], error: `步长必须大于 0：${token}` }
    const units = Math.round(value * 2)
    if (Math.abs(units / 2 - value) > 1e-9) {
      return { values: [], error: `档位换算只允许 0.5cm 的整数倍：${token}` }
    }
    if (!values.includes(units / 2)) values.push(units / 2)
  }
  values.sort((a, b) => a - b)
  return { values, error: '' }
}

export function validateTrialConfig(config: TrialConfig): string {
  if (config.heightStepsCm.length === 0) return '至少给一种身高步长'
  if (config.heightAnchorsCm.length === 0) return '至少给一种身高起点'
  if (config.chestStepsCm.length === 0) return '至少给一种胸围步长'
  if (config.boundaryRules.length === 0) return '至少选一种边界规则'
  const combos =
    config.heightStepsCm.length *
    config.heightAnchorsCm.length *
    config.chestStepsCm.length *
    config.boundaryRules.length
  if (combos > MAX_COMBINATIONS) {
    return `候选组合共 ${combos} 套，超过单次上限 ${MAX_COMBINATIONS} 套，请减少候选值`
  }
  if (config.maxBins <= 0) return '工厂档数上限必须大于 0'
  if (config.unitPrice < 0) return '单价不能为负'
  return ''
}

function paramsText(params: TrialParams): string {
  return `身高步长 ${params.heightStepCm}cm / 起点 ${params.heightAnchorCm}cm / 胸围步长 ${params.chestStepCm}cm / ${BOUNDARY_TEXT[params.boundaryRule]}`
}

function genderText(gender: 'male' | 'female'): string {
  return gender === 'male' ? '男' : '女'
}

function money(value: number): string {
  return `¥${Math.round(value * 100) / 100}`
}

/** 相对当前排产方案的取舍结论：多（少）几档换来的是更均匀还是更省备货 */
function buildVerdict(scheme: TrialScheme, baseline: TrialScheme | undefined, unitPrice: number): string {
  if (scheme.isBaseline || !baseline) return '当前排产方案（对照基准）'
  const parts: string[] = []

  const binDelta = scheme.binCount - baseline.binCount
  parts.push(binDelta === 0 ? '档数相同' : binDelta > 0 ? `多 ${binDelta} 档` : `少 ${-binDelta} 档`)

  const gapDelta = scheme.maxGap - baseline.maxGap
  if (gapDelta < 0) parts.push(`最挤与最空档差缩小 ${-gapDelta} 人（人数更均匀）`)
  else if (gapDelta > 0) parts.push(`档差扩大 ${gapDelta} 人（人数更不均）`)
  else parts.push('档差持平（均匀度不变）')

  const stockDelta = scheme.totalStock - baseline.totalStock
  const priceDelta = stockDelta * unitPrice
  if (stockDelta < 0) parts.push(`少备 ${-stockDelta} 套（省 ${money(-priceDelta)}）`)
  else if (stockDelta > 0) parts.push(`多备 ${stockDelta} 套（加 ${money(priceDelta)}）`)
  else parts.push('备货持平（总价不变）')

  return parts.join('，')
}

/**
 * 跑完整试算：四个维度笛卡尔积逐套用生产同一份归并 + 汇总计算。
 * 不改动项目本身（人员按浅拷贝重算，项目结果保持原样）。
 */
export function runTrial(project: Project, baseRule: SizeRule, config: TrialConfig): TrialRecord {
  const startedAt = Date.now()
  const baseParams = paramsOfRule(baseRule)

  const combos: TrialParams[] = []
  for (const heightStepCm of config.heightStepsCm) {
    for (const heightAnchorCm of config.heightAnchorsCm) {
      for (const chestStepCm of config.chestStepsCm) {
        for (const boundaryRule of config.boundaryRules) {
          combos.push({ heightStepCm, heightAnchorCm, chestStepCm, boundaryRule })
        }
      }
    }
  }

  const schemes: TrialScheme[] = combos.map((params) => {
    const variantRule = buildVariantRule(baseRule, params)
    // 浅拷贝人员：runMerge 只会整体替换 result，不改动原始数据
    const trialPersons = project.persons.map((person) => ({ ...person }))
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
    runMerge({ ...project, persons: trialPersons }, variantRule)
    const summary = buildSummary(trialPersons, variantRule, {
      totalRows: project.persons.length,
      ruleVersion: baseRule.version
    })
    const ended = typeof performance !== 'undefined' ? performance.now() : Date.now()

    const regularBins = summary.regularRows
    const binCount = new Set(regularBins.map((row) => row.sizeCode)).size
    let maxQty = 0
    let minQty = regularBins.length > 0 ? Number.POSITIVE_INFINITY : 0
    let maxRow = regularBins[0]
    let minRow = regularBins[0]
    for (const row of regularBins) {
      if (row.qty > maxQty) {
        maxQty = row.qty
        maxRow = row
      }
      if (row.qty < minQty) {
        minQty = row.qty
        minRow = row
      }
    }
    if (!Number.isFinite(minQty)) minQty = 0

    let regularStock = 0
    let specialStock = 0
    for (const row of summary.distribution) {
      if (row.isSpecial) specialStock += row.suggestion
      else regularStock += row.suggestion
    }

    const bins = [...summary.regularRows, ...summary.specialRows].map((row) => ({
      sizeCode: row.sizeCode,
      gender: row.gender,
      isSpecial: row.isSpecial,
      qty: row.qty,
      stock: stockSuggestion(row.qty, row.isSpecial)
    }))

    const totalStock = regularStock + specialStock
    const scheme: TrialScheme = {
      id: schemeId(params),
      params,
      isBaseline: paramsEqual(params, baseParams),
      binCount,
      specialBinCount: summary.specialRows.length,
      peopleCount: summary.totals.regularQty,
      specialPeople: summary.totals.specialPersonCount,
      maxQty,
      maxBinLabel: maxRow ? `${genderText(maxRow.gender)} ${maxRow.sizeCode}` : '—',
      minQty,
      minBinLabel: minRow ? `${genderText(minRow.gender)} ${minRow.sizeCode}` : '—',
      maxGap: maxQty - minQty,
      regularStock,
      specialStock,
      totalStock,
      totalPrice: Math.round(totalStock * config.unitPrice * 100) / 100,
      unmergedCount: summary.unmerged.length,
      feasible: binCount <= config.maxBins && binCount > 0,
      rank: null,
      verdict: '',
      bins,
      durationMs: Math.round((ended - started) * 100) / 100
    }
    return scheme
  })

  const baseline = schemes.find((scheme) => scheme.isBaseline)

  // 取舍口径（两套都排得下时以此为准）：
  // 先比备货总价（省者优先）→ 再比最挤/最空档差（均匀者优先）→ 再比档数（少者优先）→ 最后按候选顺序
  const feasible = schemes.filter((scheme) => scheme.feasible)
  feasible.sort((a, b) => {
    if (a.totalPrice !== b.totalPrice) return a.totalPrice - b.totalPrice
    if (a.maxGap !== b.maxGap) return a.maxGap - b.maxGap
    if (a.binCount !== b.binCount) return a.binCount - b.binCount
    return combos.findIndex((p) => paramsEqual(p, a.params)) - combos.findIndex((p) => paramsEqual(p, b.params))
  })
  feasible.forEach((scheme, index) => {
    scheme.rank = index + 1
  })

  for (const scheme of schemes) scheme.verdict = buildVerdict(scheme, baseline, config.unitPrice)

  // 展示顺序：推荐方案（可行且最优）在前，其后其余可行方案，最后超限方案
  const ranked = new Map(feasible.map((scheme, index) => [scheme.id, index]))
  schemes.sort((a, b) => {
    const ra = ranked.has(a.id) ? ranked.get(a.id)! : Number.POSITIVE_INFINITY
    const rb = ranked.has(b.id) ? ranked.get(b.id)! : Number.POSITIVE_INFINITY
    if (ra !== rb) return ra - rb
    return combos.findIndex((p) => paramsEqual(p, a.params)) - combos.findIndex((p) => paramsEqual(p, b.params))
  })

  return {
    projectId: project.id,
    baseRuleVersion: baseRule.version,
    baseRule: JSON.parse(JSON.stringify(baseRule)) as SizeRule,
    totalRows: project.persons.length,
    validRows: project.persons.filter((person) => person.status === 'active').length,
    config: {
      heightStepsCm: [...config.heightStepsCm],
      heightAnchorsCm: [...config.heightAnchorsCm],
      chestStepsCm: [...config.chestStepsCm],
      boundaryRules: [...config.boundaryRules],
      maxBins: config.maxBins,
      unitPrice: config.unitPrice
    },
    schemes,
    recommendedSchemeId: feasible[0]?.id ?? null,
    selectedSchemeId: null,
    selectedRuleVersion: null,
    createdAt: startedAt,
    updatedAt: startedAt
  }
}

export { paramsText }
