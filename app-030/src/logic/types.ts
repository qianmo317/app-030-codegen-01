/** 领域模型：量体数据、号型规则、归并结果与汇总 */

export type Gender = 'male' | 'female'
export type PatternFit = 'Y' | 'A' | 'B' | 'C'
/** 边界规则：round_up = 边界归上（167.5 → 170）；nearest = 就近归下（167.5 → 165） */
export type BoundaryRule = 'round_up' | 'nearest'
export type ProjectKind = 'school' | 'factory' | 'other'

export type FitRange = { fit: PatternFit; minCm: number; maxCm: number }
export type GenderFitRule = { gender: Gender; ranges: FitRange[] }
export type SpecialFlag = { code: string; label: string }

/** 身高体重 → 建议初始号型的估算参数（仅作录入参考） */
export type SizeEstimateConfig = {
  standardWeightBaseCm: number
  maleWeightFactor: number
  femaleWeightFactor: number
  maleChestRatio: number
  femaleChestRatio: number
  maleBmiRef: number
  femaleBmiRef: number
  bmiChestFactor: number
  maleDefaultDiffCm: number
  femaleDefaultDiffCm: number
}

/** 号型规则（版本化，项目锁定版本后不随规则改版而变） */
export type SizeRule = {
  version: string
  label: string
  builtin: boolean
  heightStepCm: number
  heightAnchor: number
  chestStepCm: number
  chestAnchor: number
  boundaryRule: BoundaryRule
  fitByChestWaistDiff: GenderFitRule[]
  specialFlags: SpecialFlag[]
  heightRangeCm: { minCm: number; maxCm: number }
  chestRangeCm: { minCm: number; maxCm: number }
  estimate: SizeEstimateConfig
  effectiveFrom: string
  note: string
}

/** 数值异常标记 */
export type AnomalyCode =
  | 'height_out_of_range'
  | 'chest_out_of_range'
  | 'missing_chest'
  | 'missing_height'
  | 'missing_waist'
  | 'diff_out_of_range'

/** active = 计入有效人数；invalid = 无效行；duplicate = 被确认为重复并排除 */
export type PersonStatus = 'active' | 'invalid' | 'duplicate'

export type ManualOverride = { sizeCode: string; by: string; reason: string; at: number }

export type PersonResult = {
  /** 生效号型（人工覆写后为覆写值） */
  sizeCode: string
  /** 按规则归并出的号型，便于对比「按规则归并 / 人工覆写」 */
  ruleSizeCode: string
  fit: PatternFit | null
  ruleVersion: string
  manualOverride?: ManualOverride
}

export type Person = {
  id: string
  name: string
  gender: Gender
  /** 班级 / 车间 */
  orgUnit: string
  batch: string
  heightCm: number
  weightKg: number | null
  chestCm: number
  waistCm: number
  specialFlag: string | null
  note: string
  status: PersonStatus
  /** 无效 / 排除的原因说明 */
  statusReason: string
  anomaly: AnomalyCode[]
  needsConfirm: boolean
  possibleDuplicateOf: string | null
  /** 导入来源行号（用于差异定位） */
  sourceRow: number | null
  source: 'manual' | 'import'
  result: PersonResult | null
  createdAt: number
}

export type ImportRecord = {
  fingerprint: string
  fileName: string
  at: number
  rows: number
  added: number
  updated: number
  invalid: number
  skipped: number
}

export type Project = {
  id: string
  name: string
  kind: ProjectKind
  /** 项目锁定的规则版本：规则改版后旧项目仍按旧版本解释 */
  ruleVersion: string
  batches: string[]
  persons: Person[]
  imports: ImportRecord[]
  perf?: { mergeMs?: number; mergeCount?: number; importParseMs?: number; importRows?: number }
  createdAt: number
  updatedAt: number
}

export type SummaryRow = { sizeCode: string; gender: Gender; qty: number; isSpecial: boolean }

/* ------------------------------- 档位方案试算 ------------------------------- */

/** 试算输入网格：四个维度各取几种值，引擎做笛卡尔积逐套计算 */
export type TrialGridConfig = {
  /** 身高步长候选（cm，0.5 的整数倍） */
  heightStepsCm: number[]
  /** 身高起点（锚点）候选 */
  heightAnchorsCm: number[]
  /** 胸围步长候选 */
  chestStepsCm: number[]
  /** 边界规则候选：边界归上 / 就近归下 */
  boundaryRules: BoundaryRule[]
}

export type TrialConfig = TrialGridConfig & {
  /** 工厂能接受的号型档数上限 */
  maxBins: number
  /** 每套单价（元），用于备货总价估算 */
  unitPrice: number
}

export type TrialParams = {
  heightStepCm: number
  heightAnchorCm: number
  chestStepCm: number
  boundaryRule: BoundaryRule
}

export type TrialBinStat = {
  sizeCode: string
  gender: Gender
  isSpecial: boolean
  qty: number
  /** 建议备货套数（与汇总/导出同一套加成口径） */
  stock: number
}

export type TrialScheme = {
  /** 参数指纹（半厘米整数拼接，避免小数比较） */
  id: string
  params: TrialParams
  /** 是否为项目当前排产所用规则 */
  isBaseline: boolean
  /** 常规号型档数（与厂方上限比较的口径，特殊单列不计入） */
  binCount: number
  specialBinCount: number
  peopleCount: number
  specialPeople: number
  maxQty: number
  maxBinLabel: string
  minQty: number
  minBinLabel: string
  /** 最挤一档与最空一档的人数差 */
  maxGap: number
  regularStock: number
  specialStock: number
  totalStock: number
  totalPrice: number
  /** 胸腰差等原因未归入常规档的人数（各套方案一致，仅提示） */
  unmergedCount: number
  /** 档数是否在厂方上限内 */
  feasible: boolean
  /** 可行方案内的推荐名次（1 = 推荐）；超限方案为 null */
  rank: number | null
  /** 相对当前排产方案的取舍结论（多几档换均匀还是省备货） */
  verdict: string
  bins: TrialBinStat[]
  durationMs: number
}

export type TrialRecord = {
  /** 一个项目只保留最近一次试算（含全部候选与选中结果） */
  projectId: string
  baseRuleVersion: string
  /** 基础规则快照（试算当时的型别 / 特殊标记等，便于离线回显与导出） */
  baseRule: SizeRule
  totalRows: number
  validRows: number
  config: TrialConfig
  /** 已按推荐口径排序 */
  schemes: TrialScheme[]
  recommendedSchemeId: string | null
  selectedSchemeId: string | null
  /** 采纳后写入规则内核的版本号 */
  selectedRuleVersion: string | null
  createdAt: number
  updatedAt: number
}