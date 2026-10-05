/* 引擎自检：半厘米整数对齐、试算分档/极差/备货/上限/推荐、汇总同源、采纳写核 */
import assert from 'node:assert'
import { alignToStep } from './src/logic/sizeRules'
import { cmToHalfUnits } from './src/logic/precision'
import { runTrial, parseHalfCmList, schemeId, paramsOfRule, validateTrialConfig, BOUNDARY_TEXT } from './src/logic/trial'
import { buildSummary, runMerge, stockSuggestion, REGULAR_STOCK_MARGIN, SPECIAL_STOCK_MARGIN } from './src/logic/merge'
import { BUILTIN_RULES } from './src/logic/sizeRules'
import type { Person, Project, SizeRule, TrialConfig } from './src/logic/types'

let passed = 0
function check(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`✓ ${name}`)
}

/* 1. 半厘米整数对齐：边界归上 / 就近归下，规格书要求的 167.5 等点 */
check('alignToStep 走半厘米整数：167.5 在两种边界规则下分别归 170 / 165', () => {
  const anchor = cmToHalfUnits(155)
  const step = cmToHalfUnits(5)
  assert.equal(alignToStep(cmToHalfUnits(167.5), anchor, step, 'round_up'), cmToHalfUnits(170))
  assert.equal(alignToStep(cmToHalfUnits(167.5), anchor, step, 'nearest'), cmToHalfUnits(165))
  assert.equal(alignToStep(cmToHalfUnits(182.5), anchor, step, 'round_up'), cmToHalfUnits(185))
  assert.equal(alignToStep(cmToHalfUnits(182.5), anchor, step, 'nearest'), cmToHalfUnits(180))
  // 边界两侧
  assert.equal(alignToStep(cmToHalfUnits(167), anchor, step, 'round_up'), cmToHalfUnits(165))
  assert.equal(alignToStep(cmToHalfUnits(168), anchor, step, 'round_up'), cmToHalfUnits(170))
  // 3cm 步长、锚点 153：156 → round_up 156（正好在档上）
  assert.equal(alignToStep(cmToHalfUnits(156), cmToHalfUnits(153), cmToHalfUnits(3), 'round_up'), cmToHalfUnits(156))
  // 157.5 距 156 为 1.5（半数）→ 归上 159
  assert.equal(alignToStep(cmToHalfUnits(157.5), cmToHalfUnits(153), cmToHalfUnits(3), 'round_up'), cmToHalfUnits(159))
  // 就近 → 156
  assert.equal(alignToStep(cmToHalfUnits(157.5), cmToHalfUnits(153), cmToHalfUnits(3), 'nearest'), cmToHalfUnits(156))
})

/* 造样本：双峰人群 + 特殊 + 未归并（胸腰差超区间） */
function makePerson(
  i: number,
  gender: 'male' | 'female',
  heightCm: number,
  chestCm: number,
  waistCm: number,
  extra: Partial<Person> = {}
): Person {
  return {
    id: `p_${i}`,
    name: `样本${i}`,
    gender,
    orgUnit: '一班',
    batch: '春装',
    heightCm,
    weightKg: null,
    chestCm,
    waistCm,
    specialFlag: null,
    note: '',
    status: 'active',
    statusReason: '',
    anomaly: [],
    needsConfirm: false,
    possibleDuplicateOf: null,
    sourceRow: i + 1,
    source: 'manual',
    result: null,
    createdAt: 0,
    ...extra
  }
}

function buildSampleProject(): Project {
  const persons: Person[] = []
  let i = 0
  // 30 个 162~164 的男装（A 型：胸腰差 12~16）
  for (let n = 0; n < 30; n++) persons.push(makePerson(i++, 'male', 162 + (n % 2) * 1.5, 86, 72))
  // 30 个 176~178 的男装
  for (let n = 0; n < 30; n++) persons.push(makePerson(i++, 'male', 176 + (n % 2) * 1.5, 96, 82))
  // 10 个 170 男装
  for (let n = 0; n < 10; n++) persons.push(makePerson(i++, 'male', 170, 90, 76))
  // 2 个特殊体型
  for (let n = 0; n < 2; n++) persons.push(makePerson(i++, 'male', 175, 110, 108, { specialFlag: 'PLUS' }))
  // 1 个胸腰差为负（未归并）
  persons.push(makePerson(i++, 'male', 170, 80, 90))
  // 1 个无效行
  persons.push(makePerson(i++, 'male', 999, 90, 76, { status: 'invalid', statusReason: '超范围' }))
  return {
    id: 'prj_test',
    name: '自检学校',
    kind: 'school',
    ruleVersion: BUILTIN_RULES[0].version,
    batches: [],
    persons,
    imports: [],
    createdAt: 0,
    updatedAt: 0
  }
}

const config: TrialConfig = {
  heightStepsCm: [3, 4, 5],
  heightAnchorsCm: [153, 155],
  chestStepsCm: [2, 4],
  boundaryRules: ['round_up', 'nearest'],
  maxBins: 12,
  unitPrice: 80
}

const project = buildSampleProject()
const baseRule: SizeRule = BUILTIN_RULES[0]

check('试算网格 = 3×2×2×2 = 24 套，含当前排产基线一套', () => {
  const record = runTrial(project, baseRule, config)
  assert.equal(record.schemes.length, 24)
  const baseline = record.schemes.find((s) => s.isBaseline)
  assert.ok(baseline, '必须标出当前排产参数那套')
  assert.equal(baseline!.params.heightStepCm, 5)
  assert.equal(baseline!.params.heightAnchorCm, 155)
  assert.equal(baseline!.params.chestStepCm, 4)
  assert.equal(baseline!.params.boundaryRule, 'round_up')
})

check('每套人数守恒：常规 + 特殊 = 72 人入档（有效 73，1 人未归并，1 人无效）', () => {
  const record = runTrial(project, baseRule, config)
  for (const scheme of record.schemes) {
    const binned = scheme.bins.reduce((sum, bin) => sum + bin.qty, 0)
    assert.equal(binned, 72, `方案 ${scheme.id} 分档人数 ${binned} 应为 72`)
    assert.equal(scheme.peopleCount + scheme.specialPeople + scheme.unmergedCount, 73)
    assert.equal(scheme.specialPeople, 2)
    assert.equal(scheme.unmergedCount, 1)
  }
})

check('最挤/最空与极差：基线 5cm 档下 5 个常规档 15/15/15/15/10 → 极差 5', () => {
  const record = runTrial(project, baseRule, config)
  const baseline = record.schemes.find((s) => s.isBaseline)!
  assert.equal(baseline.binCount, 5)
  assert.equal(baseline.maxQty, 15)
  assert.equal(baseline.minQty, 10)
  assert.equal(baseline.maxGap, 5)
  assert.ok(baseline.maxBinLabel.includes('/'))
})

check('备货：逐档 ceil(qty×1.05) 常规 / ×1.10 特殊，且不少于 1 套', () => {
  assert.equal(stockSuggestion(30, false), Math.ceil(30 * (1 + REGULAR_STOCK_MARGIN)))
  assert.equal(stockSuggestion(2, true), Math.ceil(2 * (1 + SPECIAL_STOCK_MARGIN)))
  assert.equal(stockSuggestion(1, false), 2)
  const record = runTrial(project, baseRule, config)
  for (const scheme of record.schemes) {
    const expected = scheme.bins.reduce((sum, bin) => sum + stockSuggestion(bin.qty, bin.isSpecial), 0)
    assert.equal(scheme.totalStock, expected)
    assert.equal(Math.round(scheme.totalPrice * 100), Math.round(scheme.totalStock * 80 * 100))
  }
})

check('厂方上限：档数 > maxBins 的方案 feasible=false 且不参与推荐', () => {
  const tight: TrialConfig = { ...config, maxBins: 3 }
  const record = runTrial(project, baseRule, tight)
  const over = record.schemes.filter((s) => !s.feasible)
  assert.ok(over.length > 0, '12 档上限下 5cm 步长方案应可行，收紧到 3 必有超限')
  for (const scheme of over) assert.equal(scheme.rank, null)
  if (record.recommendedSchemeId) {
    const rec = record.schemes.find((s) => s.id === record.recommendedSchemeId)!
    assert.equal(rec.feasible, true)
    assert.equal(rec.rank, 1)
  }
})

check('推荐口径：可行方案内总价低 > 极差小 > 档数少', () => {
  const record = runTrial(project, baseRule, config)
  const rec = record.schemes.find((s) => s.id === record.recommendedSchemeId)!
  assert.equal(rec.rank, 1)
  for (const other of record.schemes.filter((s) => s.feasible && s.id !== rec.id)) {
    const before =
      rec.totalPrice < other.totalPrice ||
      (rec.totalPrice === other.totalPrice && rec.maxGap < other.maxGap) ||
      (rec.totalPrice === other.totalPrice && rec.maxGap === other.maxGap && rec.binCount <= other.binCount)
    assert.ok(before, `推荐方案必须在口径上不劣于 ${other.id}`)
  }
})

check('verdict 文案：非基线方案说明多/少几档、均匀度、备货钱数', () => {
  const record = runTrial(project, baseRule, config)
  const baseline = record.schemes.find((s) => s.isBaseline)!
  for (const scheme of record.schemes) {
    if (scheme.isBaseline) assert.match(scheme.verdict, /对照基准/)
    else assert.match(scheme.verdict, /档/)
  }
  assert.ok(baseline.verdict.length > 0)
})

check('试算与生产同源：采纳参数后 runMerge+buildSummary 结果与试算 bins 完全一致', () => {
  const record = runTrial(project, baseRule, config)
  const rec = record.schemes.find((s) => s.id === record.recommendedSchemeId)!
  const variant: SizeRule = {
    ...baseRule,
    heightStepCm: rec.params.heightStepCm,
    heightAnchor: rec.params.heightAnchorCm,
    chestStepCm: rec.params.chestStepCm,
    boundaryRule: rec.params.boundaryRule
  }
  const adoptedProject: Project = JSON.parse(JSON.stringify(project))
  runMerge(adoptedProject, variant)
  const summary = buildSummary(adoptedProject.persons, variant)
  const trialBins = new Map(rec.bins.map((bin) => [`${bin.isSpecial}-${bin.sizeCode}-${bin.gender}`, bin]))
  assert.equal(summary.allRows.length, rec.bins.length)
  for (const row of summary.allRows) {
    const bin = trialBins.get(`${row.isSpecial}-${row.sizeCode}-${row.gender}`)
    assert.ok(bin, `生产结果多出档 ${row.sizeCode}/${row.gender}`)
    assert.equal(bin!.qty, row.qty)
    assert.equal(bin!.stock, stockSuggestion(row.qty, row.isSpecial))
  }
  assert.equal(summary.conserved, false, '含 1 个未归并行时不守恒，符合预期')
})

check('试算不改动项目本身：跑完项目 ruleVersion 与人员 result 保持原样', () => {
  const snapshot: Project = JSON.parse(JSON.stringify(project))
  runTrial(project, baseRule, config)
  assert.equal(project.ruleVersion, snapshot.ruleVersion)
  assert.deepStrictEqual(
    project.persons.map((p) => p.result),
    snapshot.persons.map((p) => p.result)
  )
})

check('参数指纹走半厘米整数：5 与 5.0 同指，1.5 步长合法，0.3 被拒', () => {
  assert.equal(
    schemeId({ heightStepCm: 5, heightAnchorCm: 155, chestStepCm: 4, boundaryRule: 'round_up' }),
    schemeId({ heightStepCm: 5.0, heightAnchorCm: 155.0, chestStepCm: 4.0, boundaryRule: 'round_up' })
  )
  const ok = parseHalfCmList('1.5, 2, 2.5')
  assert.deepEqual(ok.values, [1.5, 2, 2.5])
  assert.equal(ok.error, '')
  const bad = parseHalfCmList('3, 0.3')
  assert.equal(bad.values.length, 0)
  assert.match(bad.error, /0\.5/)
  const bad2 = parseHalfCmList('0')
  assert.match(bad2.error, /大于 0/)
})

check('组合数上限保护', () => {
  const huge: TrialConfig = {
    heightStepsCm: [1, 2, 3, 4, 5],
    heightAnchorsCm: [153, 154, 155],
    chestStepsCm: [1, 2, 3, 4],
    boundaryRules: ['round_up', 'nearest'],
    maxBins: 40,
    unitPrice: 1
  } // 5×3×4×2 = 120，合法
  assert.equal(validateTrialConfig(huge), '')
  const tooMany = { ...huge, heightAnchorsCm: [150, 151, 152, 153, 154, 155, 156, 157] } // 320
  assert.match(validateTrialConfig(tooMany), /超过单次上限/)
})

check('基线识别：paramsOfRule 与规则内核一致，BOUNDARY_TEXT 两种都有文案', () => {
  assert.deepEqual(paramsOfRule(baseRule), {
    heightStepCm: 5,
    heightAnchorCm: 155,
    chestStepCm: 4,
    boundaryRule: 'round_up'
  })
  assert.equal(BOUNDARY_TEXT.round_up, '边界归上')
  assert.equal(BOUNDARY_TEXT.nearest, '就近归下')
})

console.log(`\n全部 ${passed} 项自检通过`)
