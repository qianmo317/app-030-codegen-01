/**
 * 档位方案试算（老师傅「拿几个人的数试几套档位」的机器化版本）。
 *
 * 关键约束（需求）：
 * - 只动四件事：身高步长、身高起点（锚点）、胸围步长、边界（归上 / 就近）；
 *   型别区间、特殊标记等一律沿用基准规则（项目当前锁定的规则版本）。
 * - 档位换算一律走半厘米整数：参数先校验为 0.5cm 整数倍，实际归桶复用 sizeRules 内核，
 *   任何地方都不直接用小数比偏移。
 * - 试算本身不改项目数据；选中的方案通过 adoptTrialScheme 落成一条正式 SizeRule 写进规则内核，
 *   页面 / 归并 / 导出随后都经 getRule(project.ruleVersion) 读同一份结果，不许各处另算。
 */
import type { BoundaryRule, Person, SizeRule, TrialParams } from './types'
import { buildSizeCode } from './sizeRules'
import { cmToHalfUnits } from './precision'

export type BoundaryOption = BoundaryRule

export type TrialOptions = {
  heightStepCms: number[]
  heightAnchorCms: number[]
  chestStepCms: number[]
  boundaryRules: BoundaryRule[]
  /** 工厂能接受的号型档（常规桶）上限 */
  maxBuckets: number
  /** 每套成衣单价（元） */
  unitPriceYuan: number
}

export type TrialBucket = {
  sizeCode: string
  gender: 'male' | 'female'
  qty: number
  /** 建议备货：常规桶 ceil(qty × 1.05) 且不少于 1（整数运算，与 merge.distribution 同口径） */
  stock: number
}

export type TrialSpecialRow = {
  flag: string
  gender: 'male' | 'female'
  qty: number
  /** 特殊单列备货：ceil(qty × 1.10) 且不少于 1 */
  stock: number
}

export type TrialScheme = {
  /** 参数签名（半厘米整数拼出），用于去重与识别「已采纳的那套」 */
  key: string
  params: TrialParams
  heightStepUnits: number
  heightAnchorUnits: number
  chestStepUnits: number
  /** 常规桶（号型 × 性别），按号型排序 */
  buckets: TrialBucket[]
  bucketCount: number
  regularQty: number
  specialRows: TrialSpecialRow[]
  specialQty: number
  specialBucketCount: number
  /** 试算样本里常规体型、但胸腰差不在基准规则区间而归不进桶的人数（每一套都一样） */
  unresolvedQty: number
  busiestQty: number
  emptiestQty: number
  /** 最挤的一档与最空的一档相差多少人 */
  spread: number
  stockQty: number
  stockPriceFen: number
  fitsLimit: boolean
}

export type TrialSample = {
  persons: Person[]
  activeCount: number
  regularCount: number
  specialCount: number
  invalidCount: number
}

export type TrialArchive = {
  id: string
  projectId: string
  projectName: string
  baseRuleVersion: string
  createdAt: number
  options: TrialOptions
  schemes: TrialScheme[]
  recommendedKey: string | null
  recommendReason: string
  policyText: string
  durationMs: number
  /** 采纳后回写：采纳的是哪套参数（按 key 匹配，旧项目重开仍能标出选中行） */
  adoptedKey: string | null
  adoptedAt: number | null
  adoptedBy: string
  adoptedRuleVersion: string | null
}

export const REGULAR_MARGIN_NUM = 105
export const REGULAR_MARGIN_DEN = 100
export const SPECIAL_MARGIN_NUM = 110
export const SPECIAL_MARGIN_DEN = 100

/** 固定裁决口径（页面展示 + 存档 + 采纳确认共用同一句话，不允许各处各说各的） */
export const TRIAL_POLICY_TEXT =
  '固定裁决口径：① 只在「档数不超过工厂上限」的方案里选；' +
  '② 都排得下时先比按套排产的备货总价，总价低的为准；' +
  '③ 总价相同再比人数均匀度（最挤一档与最空一档的差，差小优先）；' +
  '④ 仍相同则档数少的为准。'

export const DEFAULT_TRIAL_OPTIONS: TrialOptions = {
  heightStepCms: [3, 4, 5],
  heightAnchorCms: [150, 155],
  chestStepCms: [2, 4],
  boundaryRules: ['round_up', 'nearest'],
  maxBuckets: 40,
  unitPriceYuan: 100
}

/* ------------------------------- 参数校验 ------------------------------- */

/**
 * 是否为 0.5cm 的整数倍：把值乘 2 后必须落在整数上（1e-9 容差只吃二进制浮点表示误差）。
 * 不写 Math.round(value*2)/2 === value 那种先取整再自比的恒真式。
 */
export function isHalfCmMultiple(value: number): boolean {
  if (!Number.isFinite(value)) return false
  const doubled = value * 2
  return Math.abs(doubled - Math.round(doubled)) < 1e-9
}

export function validateTrialOptions(options: TrialOptions): string {
  if (options.heightStepCms.length === 0) return '请至少选择一种身高步长'
  if (options.heightAnchorCms.length === 0) return '请至少选择一种身高起点'
  if (options.chestStepCms.length === 0) return '请至少选择一种胸围步长'
  if (options.boundaryRules.length === 0) return '请至少选择一种边界规则'
  const checkList: [number[], string, boolean][] = [
    [options.heightStepCms, '身高步长', true],
    [options.heightAnchorCms, '身高起点', false],
    [options.chestStepCms, '胸围步长', true]
  ]
  for (const [values, label, positive] of checkList) {
    for (const value of values) {
      if (!Number.isFinite(value) || !isHalfCmMultiple(value)) {
        return `${label} ${value} 不是 0.5cm 的整数倍，档位换算一律走半厘米整数`
      }
      if (positive && value <= 0) return `${label}必须大于 0`
    }
  }
  const combos =
    options.heightStepCms.length *
    options.heightAnchorCms.length *
    options.chestStepCms.length *
    options.boundaryRules.length
  if (combos > 200) return `组合数 ${combos} 套过多，请精简到 200 套以内`
  if (options.maxBuckets <= 0 || !Number.isInteger(options.maxBuckets)) return '工厂档数上限必须是正整数'
  if (!(options.unitPriceYuan > 0)) return '每套单价必须大于 0'
  return ''
}

/* ------------------------------- 规则变体 ------------------------------- */

/**
 * 由基准规则派生一套试算规则：只覆盖四个档位参数，其余字段（型别区间、特殊标记、
 * 可判定范围等）整份沿用——保证试算与正式归并走的是同一个引擎。
 */
export function buildTrialRule(base: SizeRule, params: TrialParams): SizeRule {
  return {
    ...base,
    heightStepCm: params.heightStepCm,
    heightAnchor: params.heightAnchorCm,
    chestStepCm: params.chestStepCm,
    chestAnchor: base.chestAnchor,
    boundaryRule: params.boundaryRule
  }
}

function paramKey(params: TrialParams): string {
  return [
    cmToHalfUnits(params.heightStepCm),
    cmToHalfUnits(params.heightAnchorCm),
    cmToHalfUnits(params.chestStepCm),
    params.boundaryRule
  ].join('|')
}

/* ------------------------------- 试算样本 ------------------------------- */

export function buildTrialSample(persons: Person[]): TrialSample {
  let activeCount = 0
  let regularCount = 0
  let specialCount = 0
  let invalidCount = 0
  for (const person of persons) {
    if (person.status !== 'active') {
      invalidCount += 1
      continue
    }
    activeCount += 1
    if (person.specialFlag) specialCount += 1
    else regularCount += 1
  }
  return {
    persons: persons.filter((person) => person.status === 'active'),
    activeCount,
    regularCount,
    specialCount,
    invalidCount
  }
}

/* ------------------------------- 单套分桶 ------------------------------- */

/** 建议备货的纯整数算法：ceil(qty * num / den)，避开浮点误差且不少于 1 */
function withMargin(qty: number, num: number, den: number): number {
  return Math.max(1, Math.ceil((qty * num) / den))
}

const GENDER_ORDER: Array<'male' | 'female'> = ['male', 'female']

function compareBucketCodes(a: string, b: string): number {
  const parse = (code: string): number[] | null => {
    const m = /^(\d+(?:\.5)?)\/(\d+(?:\.5)?)([YABC])$/.exec(code)
    if (!m) return null
    return [cmToHalfUnits(Number(m[1])), cmToHalfUnits(Number(m[2])), 'YABC'.indexOf(m[3])]
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return a.localeCompare(b)
  for (let i = 0; i < pa.length; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function evaluateScheme(params: TrialParams, rule: SizeRule, sample: TrialSample): TrialScheme {
  const regularMap = new Map<string, { sizeCode: string; gender: 'male' | 'female'; qty: number }>()
  const specialMap = new Map<string, TrialSpecialRow>()
  let unresolvedQty = 0
  let regularQty = 0
  let specialQty = 0

  for (const person of sample.persons) {
    if (person.specialFlag) {
      specialQty += 1
      const key = `${person.specialFlag}|${person.gender}`
      const existing = specialMap.get(key)
      if (existing) existing.qty += 1
      else specialMap.set(key, { flag: person.specialFlag, gender: person.gender, qty: 1, stock: 0 })
      continue
    }
    // 试算只看规则本身：不读人工覆写，否则换档位时结果会被旧覆写污染
    const built = buildSizeCode(rule, person.gender, person.heightCm, person.chestCm, person.waistCm)
    if (!built) {
      unresolvedQty += 1
      continue
    }
    regularQty += 1
    const key = `${built.sizeCode}|${person.gender}`
    const existing = regularMap.get(key)
    if (existing) existing.qty += 1
    else regularMap.set(key, { sizeCode: built.sizeCode, gender: person.gender, qty: 1 })
  }

  const buckets: TrialBucket[] = [...regularMap.values()]
    .map((row) => ({ ...row, stock: withMargin(row.qty, REGULAR_MARGIN_NUM, REGULAR_MARGIN_DEN) }))
    .sort((a, b) => {
      if (a.gender !== b.gender) return a.gender === 'male' ? -1 : 1
      return compareBucketCodes(a.sizeCode, b.sizeCode)
    })

  const specialRows = [...specialMap.values()]
    .map((row) => ({ ...row, stock: withMargin(row.qty, SPECIAL_MARGIN_NUM, SPECIAL_MARGIN_DEN) }))
    .sort((a, b) => GENDER_ORDER.indexOf(a.gender) - GENDER_ORDER.indexOf(b.gender) || a.flag.localeCompare(b.flag))

  const qties = buckets.map((bucket) => bucket.qty)
  const busiestQty = qties.length ? Math.max(...qties) : 0
  const emptiestQty = qties.length ? Math.min(...qties) : 0
  const stockQty =
    buckets.reduce((sum, bucket) => sum + bucket.stock, 0) +
    specialRows.reduce((sum, row) => sum + row.stock, 0)

  return {
    key: paramKey(params),
    params,
    heightStepUnits: cmToHalfUnits(params.heightStepCm),
    heightAnchorUnits: cmToHalfUnits(params.heightAnchorCm),
    chestStepUnits: cmToHalfUnits(params.chestStepCm),
    buckets,
    bucketCount: buckets.length,
    regularQty,
    specialRows,
    specialQty,
    specialBucketCount: specialRows.length,
    unresolvedQty,
    busiestQty,
    emptiestQty,
    spread: busiestQty - emptiestQty,
    stockQty,
    stockPriceFen: 0,
    fitsLimit: false
  }
}

/* ------------------------------- 批量试算 + 推荐 ------------------------------- */

/** 推荐理由（同时也是 archive.recommendReason，存档里留得住「当时为什么选它」） */
export function recommendReason(schemes: TrialScheme[], maxBuckets: number): { key: string | null; reason: string } {
  const feasible = schemes.filter((scheme) => scheme.fitsLimit)
  if (feasible.length === 0) {
    if (schemes.length === 0) return { key: null, reason: '没有可计算的方案。' }
    const least = [...schemes].sort((a, b) => a.bucketCount - b.bucketCount)[0]
    return {
      key: null,
      reason: `没有一套排得下：工厂上限 ${maxBuckets} 档，最少的一套也要 ${least.bucketCount} 档。请放宽档数上限或减小步长再试。`
    }
  }
  const winner = rankSchemes(feasible)[0]
  const priceFen = winner.stockPriceFen
  const samePrice = feasible.filter((scheme) => scheme.stockPriceFen === priceFen)
  const reasonParts = [
    `档数 ${winner.bucketCount} ≤ 工厂上限 ${maxBuckets}；`,
    `按套排产备货 ${winner.stockQty} 套、总价 ${formatPriceFen(winner.stockPriceFen)}（可行方案里最低）`
  ]
  if (samePrice.length === 1) {
    reasonParts.push('。')
    return { key: winner.key, reason: reasonParts.join('') }
  }
  // 同价：按裁决口径逐级交代是在哪一级分出胜负的
  const minSpread = Math.min(...samePrice.map((scheme) => scheme.spread))
  const spreadWinners = samePrice.filter((scheme) => scheme.spread === minSpread)
  if (spreadWinners.length === 1) {
    reasonParts.push(`；与 ${samePrice.length - 1} 套同价，按人数均匀度取最挤−最空=${minSpread} 人。`)
    return { key: winner.key, reason: reasonParts.join('') }
  }
  const minBuckets = Math.min(...spreadWinners.map((scheme) => scheme.bucketCount))
  const bucketWinners = spreadWinners.filter((scheme) => scheme.bucketCount === minBuckets)
  if (bucketWinners.length === 1) {
    reasonParts.push(`；${samePrice.length - 1} 套同价、${spreadWinners.length - 1} 套均匀度相同（差 ${minSpread} 人），按档数少取 ${minBuckets} 档。`)
    return { key: winner.key, reason: reasonParts.join('') }
  }
  reasonParts.push(`；总价、均匀度（差 ${minSpread} 人）、档数（${minBuckets} 档）全部相同，按参数次序确定。`)
  return { key: winner.key, reason: reasonParts.join('') }
}

/**
 * 推荐排序（裁决口径的代码化，任何地方都不许再手写一套比较）：
 * 可行优先 → 备货总价低 → 人数差小 → 档数少 → 参数稳定排序兜底。
 */
export function rankSchemes(schemes: TrialScheme[]): TrialScheme[] {
  return [...schemes].sort((a, b) => {
    if (a.fitsLimit !== b.fitsLimit) return a.fitsLimit ? -1 : 1
    if (a.stockPriceFen !== b.stockPriceFen) return a.stockPriceFen - b.stockPriceFen
    if (a.spread !== b.spread) return a.spread - b.spread
    if (a.bucketCount !== b.bucketCount) return a.bucketCount - b.bucketCount
    if (a.heightStepUnits !== b.heightStepUnits) return a.heightStepUnits - b.heightStepUnits
    if (a.chestStepUnits !== b.chestStepUnits) return a.chestStepUnits - b.chestStepUnits
    if (a.heightAnchorUnits !== b.heightAnchorUnits) return a.heightAnchorUnits - b.heightAnchorUnits
    if (a.params.boundaryRule !== b.params.boundaryRule) {
      return a.params.boundaryRule === 'round_up' ? -1 : 1
    }
    return 0
  })
}

export type TrialRun = {
  archive: Omit<TrialArchive, 'id' | 'projectId' | 'projectName' | 'createdAt' | 'adoptedKey' | 'adoptedAt' | 'adoptedBy' | 'adoptedRuleVersion'>
  durationMs: number
}

/**
 * 跑一遍试算：笛卡尔展开四组取值，逐套归桶统计；
 * 不同参数组若结果桶集相同只保留一份（参数值原样保留，便于看出哪些组等价）。
 */
export function runTrial(baseRule: SizeRule, persons: Person[], options: TrialOptions): TrialRun {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const invalid = validateTrialOptions(options)
  if (invalid) throw new Error(invalid)

  const sample = buildTrialSample(persons)
  const unitPriceFen = Math.round(options.unitPriceYuan * 100)

  const byKey = new Map<string, TrialScheme>()
  for (const heightStepCm of options.heightStepCms) {
    for (const heightAnchorCm of options.heightAnchorCms) {
      for (const chestStepCm of options.chestStepCms) {
        for (const boundaryRule of options.boundaryRules) {
          const params: TrialParams = { heightStepCm, heightAnchorCm, chestStepCm, boundaryRule }
          const key = paramKey(params)
          if (byKey.has(key)) continue
          const rule = buildTrialRule(baseRule, params)
          const scheme = evaluateScheme(params, rule, sample)
          scheme.fitsLimit = scheme.bucketCount <= options.maxBuckets
          scheme.stockPriceFen = scheme.stockQty * unitPriceFen
          byKey.set(key, scheme)
        }
      }
    }
  }

  const schemes = rankSchemes([...byKey.values()])
  const recommendation = recommendReason(schemes, options.maxBuckets)
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const durationMs = Math.round((ended - started) * 100) / 100

  return {
    archive: {
      baseRuleVersion: baseRule.version,
      options,
      schemes,
      recommendedKey: recommendation.key,
      recommendReason: recommendation.reason,
      policyText: TRIAL_POLICY_TEXT,
      durationMs
    },
    durationMs
  }
}

/* ------------------------------- 采纳：落进规则内核 ------------------------------- */

/**
 * 基准规则里「试算不允许动」的语义指纹：型别区间、特殊标记、可判定范围、胸围锚点。
 * 只有指纹一致的两条规则，采纳同一套四参数时才允许复用同一条试算规则
 * （否则 v1.0.0 / v1.1.0 女装区间不同却共用一条规则，会算错）。
 */
export function trialBaseFingerprint(rule: SizeRule): string {
  return JSON.stringify({
    chestAnchor: cmToHalfUnits(rule.chestAnchor),
    ranges: rule.fitByChestWaistDiff.map((group) => ({
      gender: group.gender,
      ranges: group.ranges.map((range) => [range.fit, cmToHalfUnits(range.minCm), cmToHalfUnits(range.maxCm)])
    })),
    heightRange: [cmToHalfUnits(rule.heightRangeCm.minCm), cmToHalfUnits(rule.heightRangeCm.maxCm)],
    chestRange: [cmToHalfUnits(rule.chestRangeCm.minCm), cmToHalfUnits(rule.chestRangeCm.maxCm)],
    flags: rule.specialFlags.map((flag) => flag.code)
  })
}

/** 试算方案落规则时的版本号：trial-参数-短随机，已存在则追加序号 */
export function buildTrialVersion(params: TrialParams, existingVersions: string[]): string {
  const base = `trial-h${cmToHalfUnits(params.heightStepCm)}-a${cmToHalfUnits(params.heightAnchorCm)}-c${cmToHalfUnits(
    params.chestStepCm
  )}-${params.boundaryRule === 'round_up' ? 'up' : 'near'}`
  if (!existingVersions.includes(base)) return base
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`
    if (!existingVersions.includes(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** 采纳标签（写进 SizeRule.label，规则页 / 导出元信息里都能看到出处） */
export function buildTrialRuleLabel(params: TrialParams, createdAt: Date): string {
  const boundary = params.boundaryRule === 'round_up' ? '边界归上' : '就近归下'
  return `档位试算采纳：身高 ${params.heightStepCm}cm 档/起点 ${params.heightAnchorCm}，胸围 ${params.chestStepCm}cm 档，${boundary}（${createdAt.toLocaleDateString('zh-CN')}）`
}

/* ------------------------------- 展示辅助 ------------------------------- */

export function boundaryLabel(boundary: BoundaryRule): string {
  return boundary === 'round_up' ? '边界归上' : '就近归下'
}

/** 分（整数）→ 元文本（不在金额上引入浮点显示误差） */
export function formatPriceFen(fen: number): string {
  const yuan = Math.floor(fen / 100)
  const cents = fen % 100
  if (cents === 0) return `¥${yuan.toLocaleString('zh-CN')}`
  return `¥${yuan.toLocaleString('zh-CN')}.${String(cents).padStart(2, '0')}`
}

export function parseCsvNumberList(text: string): number[] {
  const values: number[] = []
  for (const part of text.split(/[,，、\s]+/)) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const value = Number(trimmed)
    if (Number.isFinite(value)) values.push(value)
  }
  return values
}
