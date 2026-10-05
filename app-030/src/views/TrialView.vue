<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { flushProject, getProject, getRule, persistProject, saveRule, store } from '../logic/store'
import {
  BOUNDARY_TEXT,
  DEFAULT_MAX_BINS,
  DEFAULT_TRIAL_GRID,
  DEFAULT_UNIT_PRICE,
  paramsText,
  parseHalfCmList,
  runTrial,
  schemeId,
  validateTrialConfig
} from '../logic/trial'
import { adoptTrialScheme, loadTrial, nextTrialVersion, saveTrial } from '../logic/trialStore'
import { trialComparisonRows, trialWorkbookSheets } from '../logic/exporter'
import { downloadBlob, downloadText, toCsvText } from '../logic/csv'
import { buildXlsxBlob } from '../logic/xlsx'
import { specialFlagLabel } from '../logic/sizeRules'
import { formatCm } from '../logic/precision'
import type { BoundaryRule, TrialParams, TrialRecord, TrialScheme } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
// 实时取项目锁定的规则：采纳后项目改锁新版本，页面各处立即按新规则解释
const baseRule = computed(() =>
  project.value ? getRule(project.value.ruleVersion) : getRule(store.rules[0]?.version ?? '')
)

const record = ref<TrialRecord | null>(null)

const form = reactive({
  heightSteps: DEFAULT_TRIAL_GRID.heightStepsCm.join(', '),
  heightAnchors: DEFAULT_TRIAL_GRID.heightAnchorsCm.join(', '),
  chestSteps: DEFAULT_TRIAL_GRID.chestStepsCm.join(', '),
  roundUp: true,
  nearest: true,
  maxBins: DEFAULT_MAX_BINS,
  unitPrice: DEFAULT_UNIT_PRICE
})

const errorText = ref('')
const message = ref('')
const running = ref(false)
const expandedId = ref<string | null>(null)
const runMeta = reactive({ count: 0, ms: 0 })

const adoptTarget = ref<TrialScheme | null>(null)
const adoptForm = reactive({ version: '', label: '', effectiveFrom: '' })

onMounted(async () => {
  const current = project.value
  if (!current) return
  const saved = await loadTrial(current.id)
  if (saved) {
    if (!saved.selectedSchemeId) {
      // 旧留档没有勾选时，默认选项目当前排产参数对应的那套（「排产中」状态由参数实时比对）
      const activeRule = getRule(current.ruleVersion)
      const matched = saved.schemes.find(
        (scheme) =>
          schemeId(scheme.params) ===
          schemeId({
            heightStepCm: activeRule.heightStepCm,
            heightAnchorCm: activeRule.heightAnchor,
            chestStepCm: activeRule.chestStepCm,
            boundaryRule: activeRule.boundaryRule
          })
      )
      if (matched) saved.selectedSchemeId = matched.id
    }
    record.value = saved
    form.heightSteps = saved.config.heightStepsCm.join(', ')
    form.heightAnchors = saved.config.heightAnchorsCm.join(', ')
    form.chestSteps = saved.config.chestStepsCm.join(', ')
    form.roundUp = saved.config.boundaryRules.includes('round_up')
    form.nearest = saved.config.boundaryRules.includes('nearest')
    form.maxBins = saved.config.maxBins
    form.unitPrice = saved.config.unitPrice
    message.value = `已读入本机留档：${new Date(saved.updatedAt).toLocaleString('zh-CN')} 的试算（${saved.schemes.length} 套方案）`
  }
})

const sampleInfo = computed(() => {
  const persons = project.value?.persons ?? []
  const valid = persons.filter((person) => person.status === 'active')
  const heights = valid.map((person) => person.heightCm).filter((value) => value > 0)
  const chests = valid.map((person) => person.chestCm).filter((value) => value > 0)
  const range = (values: number[]) =>
    values.length ? `${formatCm(Math.min(...values))}~${formatCm(Math.max(...values))}` : '—'
  return {
    total: persons.length,
    valid: valid.length,
    special: valid.filter((person) => person.specialFlag).length,
    heightRange: range(heights),
    chestRange: range(chests)
  }
})

function readConfig(): { ok: true; config: ReturnType<typeof buildConfig> } | { ok: false; error: string } {
  const steps = parseHalfCmList(form.heightSteps)
  if (steps.error) return { ok: false, error: `身高步长：${steps.error}` }
  const anchors = parseHalfCmList(form.heightAnchors)
  if (anchors.error) return { ok: false, error: `身高起点：${anchors.error}` }
  const chest = parseHalfCmList(form.chestSteps)
  if (chest.error) return { ok: false, error: `胸围步长：${chest.error}` }
  const boundaries: BoundaryRule[] = [
    ...(form.roundUp ? (['round_up'] as BoundaryRule[]) : []),
    ...(form.nearest ? (['nearest'] as BoundaryRule[]) : [])
  ]
  const config = buildConfig(steps.values, anchors.values, chest.values, boundaries)
  const invalid = validateTrialConfig(config)
  if (invalid) return { ok: false, error: invalid }
  return { ok: true, config }
}

function buildConfig(
  heightStepsCm: number[],
  heightAnchorsCm: number[],
  chestStepsCm: number[],
  boundaryRules: BoundaryRule[]
) {
  return {
    heightStepsCm,
    heightAnchorsCm,
    chestStepsCm,
    boundaryRules,
    maxBins: Math.round(Number(form.maxBins) || 0),
    unitPrice: Math.round((Number(form.unitPrice) || 0) * 100) / 100
  }
}

function schemeIdEqual(a: TrialParams, b: TrialParams): boolean {
  return schemeId(a) === schemeId(b)
}

async function run(): Promise<void> {
  const current = project.value
  errorText.value = ''
  message.value = ''
  if (!current) return
  if (sampleInfo.value.valid === 0) {
    errorText.value = '项目里还没有有效量体数据，无法试算；请先录入或导入样本。'
    return
  }
  const parsed = readConfig()
  if (!parsed.ok) {
    errorText.value = parsed.error
    return
  }
  running.value = true
  const started = performance.now()
  // 用 setTimeout 让「正在试算」提示先渲染
  await new Promise((resolve) => window.setTimeout(resolve, 30))
  const result = runTrial(current, baseRule.value, parsed.config)
  const previous = record.value
  if (previous && previous.selectedSchemeId && previous.selectedRuleVersion !== current.ruleVersion) {
    // 上次只选中、未采纳：保留勾选（参数指纹相同就能接上）
    const kept = result.schemes.find((scheme) => scheme.id === previous.selectedSchemeId)
    if (kept) {
      result.selectedSchemeId = kept.id
      result.selectedRuleVersion = null
    }
  } else {
    // 已采纳（或第一次试算）：按项目当前排产参数回选基线，保证状态显示为「排产中」
    const currentParams = {
      heightStepCm: baseRule.value.heightStepCm,
      heightAnchorCm: baseRule.value.heightAnchor,
      chestStepCm: baseRule.value.chestStepCm,
      boundaryRule: baseRule.value.boundaryRule
    }
    const currentScheme = result.schemes.find((scheme) => schemeIdEqual(scheme.params, currentParams))
    if (currentScheme) {
      result.selectedSchemeId = currentScheme.id
      result.selectedRuleVersion = current.ruleVersion
    }
  }
  result.updatedAt = Date.now()
  await saveTrial(result)
  record.value = result
  runMeta.count = result.schemes.length
  runMeta.ms = Math.round(performance.now() - started)
  running.value = false
  message.value = `已试算 ${result.schemes.length} 套方案并写入本机留档（耗时 ${runMeta.ms} ms），重新打开页面结果仍在`
}

const selectedScheme = computed(() =>
  record.value?.schemes.find((scheme) => scheme.id === record.value?.selectedSchemeId) ?? null
)
const selectedIsCurrent = computed(() => {
  const current = project.value
  const scheme = selectedScheme.value
  if (!current || !scheme) return false
  const rule = getRule(current.ruleVersion)
  return (
    rule.heightStepCm === scheme.params.heightStepCm &&
    rule.heightAnchor === scheme.params.heightAnchorCm &&
    rule.chestStepCm === scheme.params.chestStepCm &&
    rule.boundaryRule === scheme.params.boundaryRule
  )
})

function mark(scheme: TrialScheme): string {
  if (record.value && scheme.id === record.value.selectedSchemeId && selectedIsCurrent.value) return '已采纳·排产中'
  if (scheme.isBaseline) return '当前排产'
  if (record.value && scheme.id === record.value.recommendedSchemeId) return '推荐'
  return ''
}

function select(scheme: TrialScheme): void {
  if (!record.value) return
  record.value.selectedSchemeId = scheme.id
  record.value.selectedRuleVersion = null
  record.value.updatedAt = Date.now()
  void saveTrial(record.value)
  message.value = `已标记「${paramsText(scheme.params)}」为选中方案（仅留档；点「采纳进规则内核」才切换排产）`
}

function openAdopt(scheme: TrialScheme): void {
  adoptTarget.value = scheme
  adoptForm.version = nextTrialVersion(store.rules)
  adoptForm.label = `试算采纳：身高${scheme.params.heightStepCm}cm档/胸围${scheme.params.chestStepCm}cm档/${scheme.binCount}个号型档`
  adoptForm.effectiveFrom = new Date().toISOString().slice(0, 10)
  errorText.value = ''
}

function closeAdopt(): void {
  adoptTarget.value = null
}

async function confirmAdopt(): Promise<void> {
  const current = project.value
  const snapshot = record.value
  const scheme = adoptTarget.value
  if (!current || !snapshot || !scheme) return
  const version = adoptForm.version.trim()
  if (!version) {
    errorText.value = '请填写写入规则内核的版本号，如 trial-1'
    return
  }
  if (store.rules.some((rule) => rule.version === version)) {
    errorText.value = `版本号 ${version} 已存在，请换一个`
    return
  }
  const adopted = await adoptTrialScheme({
    project: current,
    baseRule: snapshot.baseRule,
    scheme,
    record: snapshot,
    version,
    label: adoptForm.label,
    effectiveFrom: adoptForm.effectiveFrom,
    existingRules: store.rules
  })
  await saveRule(adopted.rule)
  persistProject(current, true)
  await flushProject(current)
  message.value = `方案已写进规则内核 ${version}：项目排产已切换，页面 / 归并 / 导出三处此后都按 ${version} 同一份结果算`
  adoptTarget.value = null
}

function toggleExpand(id: string): void {
  expandedId.value = expandedId.value === id ? null : id
}

function exportCsv(): void {
  if (!record.value || !project.value) return
  const stamp = new Date()
  const safeName = project.value.name.replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  downloadText(
    toCsvText(trialComparisonRows(record.value)),
    `${safeName}-档位试算对照-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(
      stamp.getDate()
    ).padStart(2, '0')}.csv`
  )
}

function exportXlsx(): void {
  if (!record.value) return
  const stamp = new Date()
  const safeName = project.value!.name.replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  downloadBlob(
    buildXlsxBlob(trialWorkbookSheets(record.value)),
    `${safeName}-档位试算对照-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(
      stamp.getDate()
    ).padStart(2, '0')}.xlsx`
  )
}
</script>

<template>
  <section v-if="!project || !baseRule" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 档位方案试算</h1>
        <div class="sub">
          拿已录入的量体数据当样本，对身高步长 / 起点 / 胸围步长 / 边界规则逐套试算，与厂方档数上限对照；
          当前基础规则 <b>{{ project.ruleVersion }}</b>（{{ baseRule.label }}）
        </div>
      </div>
      <div class="spacer"></div>
      <RouterLink class="btn btn-sm" :to="`/merge/${project.id}`">去归并页</RouterLink>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>试算样本</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">档位换算一律走 0.5cm 整数，不用小数直接比偏移</span>
      </div>
      <div class="card-body tight">
        <div class="stat-row">
          <div class="stat"><div class="stat-label">总录入</div><div class="stat-value">{{ sampleInfo.total }}</div></div>
          <div class="stat"><div class="stat-label">有效样本</div><div class="stat-value">{{ sampleInfo.valid }}</div></div>
          <div class="stat"><div class="stat-label">特殊单列</div><div class="stat-value">{{ sampleInfo.special }}</div></div>
          <div class="stat"><div class="stat-label">身高范围(cm)</div><div class="stat-value">{{ sampleInfo.heightRange }}</div></div>
          <div class="stat"><div class="stat-label">胸围范围(cm)</div><div class="stat-value">{{ sampleInfo.chestRange }}</div></div>
        </div>
        <p class="hint">
          特殊体型只单列入备货、不参与号型档数；胸腰差超区间未归并的人数各套方案一致，会在对照表里提示。
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>试算参数（各取几种值，全部组合逐套算）</h3></div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">身高步长候选 (cm，0.5 的整数倍，逗号分隔)</span>
            <input v-model="form.heightSteps" class="input" type="text" placeholder="3, 4, 5" />
          </label>
          <label class="field">
            <span class="field-label">身高起点候选 (cm，即锚点)</span>
            <input v-model="form.heightAnchors" class="input" type="text" placeholder="153, 155" />
          </label>
          <label class="field">
            <span class="field-label">胸围步长候选 (cm)</span>
            <input v-model="form.chestSteps" class="input" type="text" placeholder="2, 4" />
          </label>
          <label class="field">
            <span class="field-label">边界规则候选</span>
            <span class="checkbox-row">
              <label><input v-model="form.roundUp" type="checkbox" /> 边界归上（167.5 → 170）</label>
              <label><input v-model="form.nearest" type="checkbox" /> 就近归下（167.5 → 165）</label>
            </span>
          </label>
          <label class="field">
            <span class="field-label">厂方档数上限（个号型档）</span>
            <input v-model.number="form.maxBins" class="input" type="number" min="1" step="1" />
          </label>
          <label class="field">
            <span class="field-label">每套单价（元，用于备货总价）</span>
            <input v-model.number="form.unitPrice" class="input" type="number" min="0" step="1" />
          </label>
        </div>
        <p v-if="errorText" class="notice notice-error" style="margin-top: 10px">{{ errorText }}</p>
        <p v-if="message" class="notice notice-ok" style="margin-top: 10px">{{ message }}</p>
        <div class="toolbar" style="margin-top: 12px">
          <button class="btn btn-primary" type="button" :disabled="running" @click="run">
            {{ running ? '正在逐套试算…' : '开始试算' }}
          </button>
          <template v-if="record">
            <button class="btn" type="button" @click="exportCsv">导出对照表 CSV</button>
            <button class="btn" type="button" @click="exportXlsx">导出对照表 Excel</button>
          </template>
          <span class="hint">备货口径与排产一致：常规档 +5%、特殊单列 +10%，逐档向上取整且不少于 1 套</span>
        </div>
      </div>
    </div>

    <div v-if="selectedScheme && record" class="card card-accent-ok">
      <div class="card-head">
        <h3>选中方案</h3>
        <div class="spacer"></div>
        <span class="badge" :class="selectedIsCurrent ? 'badge-ok' : 'badge-warn'">
          {{ selectedIsCurrent ? '已写进规则内核 · 排产中' : '仅试算留档，尚未切换排产' }}
        </span>
      </div>
      <div class="card-body tight">
        <p>
          <b>{{ paramsText(selectedScheme.params) }}</b> —— {{ selectedScheme.binCount }} 个常规号型档，
          最挤 {{ selectedScheme.maxQty }} 人 / 最空 {{ selectedScheme.minQty }} 人 / 差 {{ selectedScheme.maxGap }} 人，
          备货 {{ selectedScheme.totalStock }} 套，总价 ¥{{ selectedScheme.totalPrice }}。
        </p>
        <p class="hint">{{ selectedScheme.verdict }}</p>
        <div v-if="!selectedIsCurrent" class="toolbar" style="margin-top: 8px">
          <button class="btn btn-primary" type="button" @click="openAdopt(selectedScheme)">采纳进规则内核（切换排产）</button>
          <span class="hint">采纳后生成新规则版本并由本项目锁定；归并、汇总、导出三处按同一版本计算，旧项目不受影响</span>
        </div>
      </div>
    </div>

    <div v-if="record" class="card">
      <div class="card-head">
        <h3>方案对照表（{{ record.schemes.length }} 套）</h3>
        <div class="spacer"></div>
        <span class="hint">取舍口径：两套都排得下时，先比备货总价，再比档差（均匀度），再比档数</span>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>标记</th>
              <th class="num">身高步长</th>
              <th class="num">起点</th>
              <th class="num">胸围步长</th>
              <th>边界</th>
              <th class="num">号型档数</th>
              <th class="num">最挤档</th>
              <th class="num">最空档</th>
              <th class="num">极差(人)</th>
              <th class="num">备货(套)</th>
              <th class="num">总价(元)</th>
              <th>未归并</th>
              <th>相对当前方案</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="scheme in record.schemes" :key="scheme.id">
              <tr
                :class="[
                  scheme.id === record.selectedSchemeId ? 'row-highlight' : '',
                  !scheme.feasible ? 'row-invalid' : ''
                ]"
              >
                <td>
                  <span v-if="mark(scheme)" class="badge" :class="scheme.feasible ? 'badge-info' : 'badge-danger'">
                    {{ mark(scheme) }}
                  </span>
                  <span v-else-if="scheme.rank" class="hint">第 {{ scheme.rank }} 位</span>
                </td>
                <td class="num">{{ scheme.params.heightStepCm }}</td>
                <td class="num">{{ scheme.params.heightAnchorCm }}</td>
                <td class="num">{{ scheme.params.chestStepCm }}</td>
                <td>{{ BOUNDARY_TEXT[scheme.params.boundaryRule] }}</td>
                <td class="num">
                  <b>{{ scheme.binCount }}</b>
                  <span v-if="scheme.specialBinCount" class="hint"> + 特殊 {{ scheme.specialBinCount }}</span>
                  <span v-if="!scheme.feasible" class="badge badge-danger" style="margin-left: 4px">超上限</span>
                </td>
                <td class="num">{{ scheme.maxQty }}<span class="hint">（{{ scheme.maxBinLabel }}）</span></td>
                <td class="num">{{ scheme.minQty }}<span class="hint">（{{ scheme.minBinLabel }}）</span></td>
                <td class="num">{{ scheme.maxGap }}</td>
                <td class="num">
                  {{ scheme.totalStock }}
                  <span class="hint">（常规 {{ scheme.regularStock }} / 特殊 {{ scheme.specialStock }}）</span>
                </td>
                <td class="num">{{ scheme.totalPrice }}</td>
                <td class="num">{{ scheme.unmergedCount }}</td>
                <td>{{ scheme.verdict }}</td>
                <td>
                  <div class="toolbar">
                    <button class="btn btn-sm" type="button" @click="toggleExpand(scheme.id)">
                      {{ expandedId === scheme.id ? '收起分档' : '看分档' }}
                    </button>
                    <button
                      class="btn btn-sm"
                      :class="scheme.id === record.selectedSchemeId ? '' : 'btn-primary'"
                      type="button"
                      @click="select(scheme)"
                    >
                      {{ scheme.id === record.selectedSchemeId ? '✓ 已选中' : '选中' }}
                    </button>
                    <button class="btn btn-sm" type="button" @click="openAdopt(scheme)">采纳</button>
                  </div>
                </td>
              </tr>
              <tr v-if="expandedId === scheme.id">
                <td colspan="14">
                  <div class="table-wrap" style="padding: 8px">
                    <table class="data-table" style="max-width: 560px">
                      <thead>
                        <tr>
                          <th>性别</th>
                          <th>号型 / 特殊标记</th>
                          <th>类型</th>
                          <th class="num">人数</th>
                          <th class="num">备货</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="bin in scheme.bins" :key="`${bin.gender}-${bin.isSpecial}-${bin.sizeCode}`">
                          <td>{{ bin.gender === 'male' ? '男' : '女' }}</td>
                          <td>{{ bin.isSpecial ? specialFlagLabel(record.baseRule, bin.sizeCode) : bin.sizeCode }}</td>
                          <td>
                            <span class="badge" :class="bin.isSpecial ? 'badge-warn' : 'badge-info'">
                              {{ bin.isSpecial ? '特殊单列' : '常规档' }}
                            </span>
                          </td>
                          <td class="num">{{ bin.qty }}</td>
                          <td class="num">{{ bin.stock }}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>怎么定哪套（取舍口径）</h3></div>
      <div class="card-body tight">
        <p>① 号型档数超过厂方上限（{{ record?.config.maxBins ?? form.maxBins }} 个）的方案一律标「超上限」，不参与推荐；</p>
        <p>② 两套都排得下时：<b>先比备货总价</b>（便宜的优先 —— 多出的档若不省钱不取）；总价相同时<b>再比最挤/最空档差</b>（人数更均匀的优先）；再相同取档数少的；</p>
        <p>③ 按此口径排在第 1 位的打「推荐」，老师傅可在对照表改选其它方案并「采纳进规则内核」；选中与试算过程都留档本机，重开还在。</p>
      </div>
    </div>

    <div v-if="adoptTarget" class="card card-accent-warn">
      <div class="card-head">
        <h3>采纳进规则内核 —— {{ paramsText(adoptTarget.params) }}</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">{{ adoptTarget.binCount }} 档 ｜ 备货 {{ adoptTarget.totalStock }} 套 ｜ ¥{{ adoptTarget.totalPrice }}</span>
      </div>
      <div class="card-body">
        <p class="hint">
          将以基础规则 {{ record?.baseRuleVersion }} 为底，仅替换身高步长 / 起点 / 胸围步长 / 边界规则四项，
          生成一个新的只读化规则版本；本项目立即锁定该版本并重新归并，人工覆写保留。
        </p>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">新版本号 <b class="req">*</b></span>
            <input v-model="adoptForm.version" class="input" type="text" placeholder="trial-1" />
          </label>
          <label class="field">
            <span class="field-label">版本说明</span>
            <input v-model="adoptForm.label" class="input" type="text" />
          </label>
          <label class="field">
            <span class="field-label">生效日期</span>
            <input v-model="adoptForm.effectiveFrom" class="input" type="date" />
          </label>
        </div>
        <div class="toolbar" style="margin-top: 10px">
          <button class="btn btn-primary" type="button" @click="confirmAdopt">确认采纳并切换排产</button>
          <button class="btn" type="button" @click="closeAdopt">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>
