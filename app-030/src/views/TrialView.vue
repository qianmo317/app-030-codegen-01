<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  adoptTrialScheme,
  ensureMerged,
  flushProject,
  getProject,
  getRule,
  getTrialArchive,
  saveTrialArchive,
  store
} from '../logic/store'
import {
  DEFAULT_TRIAL_OPTIONS,
  TRIAL_POLICY_TEXT,
  boundaryLabel,
  formatPriceFen,
  isHalfCmMultiple,
  parseCsvNumberList,
  runTrial,
  validateTrialOptions,
  type TrialArchive,
  type TrialScheme
} from '../logic/trial'
import { trialCompareRows } from '../logic/exporter'
import { downloadText, toCsvText } from '../logic/csv'
import { specialFlagLabel } from '../logic/sizeRules'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

const archive = ref<TrialArchive | null>(null)
const running = ref(false)
const message = ref('')
const errorText = ref('')
const expandedKeys = ref<string[]>([])

const form = reactive({
  heightStepsText: DEFAULT_TRIAL_OPTIONS.heightStepCms.join(', '),
  heightAnchorsText: DEFAULT_TRIAL_OPTIONS.heightAnchorCms.join(', '),
  chestStepsText: DEFAULT_TRIAL_OPTIONS.chestStepCms.join(', '),
  roundUp: true,
  nearest: true,
  maxBuckets: DEFAULT_TRIAL_OPTIONS.maxBuckets,
  unitPriceYuan: DEFAULT_TRIAL_OPTIONS.unitPriceYuan
})

onMounted(async () => {
  const current = project.value
  if (!current) return
  const saved = await getTrialArchive(current.id)
  if (saved) {
    archive.value = saved
    form.heightStepsText = saved.options.heightStepCms.join(', ')
    form.heightAnchorsText = saved.options.heightAnchorCms.join(', ')
    form.chestStepsText = saved.options.chestStepCms.join(', ')
    form.roundUp = saved.options.boundaryRules.includes('round_up')
    form.nearest = saved.options.boundaryRules.includes('nearest')
    form.maxBuckets = saved.options.maxBuckets
    form.unitPriceYuan = saved.options.unitPriceYuan
  }
})

const sampleStats = computed(() => {
  const persons = project.value?.persons ?? []
  let active = 0
  let regular = 0
  let special = 0
  let excluded = 0
  for (const person of persons) {
    if (person.status !== 'active') {
      excluded += 1
      continue
    }
    active += 1
    if (person.specialFlag) special += 1
    else regular += 1
  }
  return { total: persons.length, active, regular, special, excluded }
})

function validateHalfList(text: string, label: string, positive: boolean): number[] | string {
  const values = parseCsvNumberList(text)
  if (values.length === 0) return `请填写${label}（0.5cm 的整数倍，多个值用逗号分隔）`
  for (const value of values) {
    if (!isHalfCmMultiple(value)) return `${label} ${value} 不是 0.5cm 的整数倍（如 3、4.5）`
    if (positive && value <= 0) return `${label}必须大于 0`
  }
  return values
}

async function run(): Promise<void> {
  const current = project.value
  if (!current) return
  errorText.value = ''
  message.value = ''

  const heightSteps = validateHalfList(form.heightStepsText, '身高步长', true)
  const heightAnchors = validateHalfList(form.heightAnchorsText, '身高起点', false)
  const chestSteps = validateHalfList(form.chestStepsText, '胸围步长', true)
  if (typeof heightSteps === 'string') {
    errorText.value = heightSteps
    return
  }
  if (typeof heightAnchors === 'string') {
    errorText.value = heightAnchors
    return
  }
  if (typeof chestSteps === 'string') {
    errorText.value = chestSteps
    return
  }
  const boundaryRules: TrialArchive['options']['boundaryRules'] = []
  if (form.roundUp) boundaryRules.push('round_up')
  if (form.nearest) boundaryRules.push('nearest')

  const options = {
    heightStepCms: [...new Set(heightSteps)],
    heightAnchorCms: [...new Set(heightAnchors)],
    chestStepCms: [...new Set(chestSteps)],
    boundaryRules,
    maxBuckets: Math.floor(Number(form.maxBuckets)),
    unitPriceYuan: Number(form.unitPriceYuan)
  }
  const invalid = validateTrialOptions(options)
  if (invalid) {
    errorText.value = invalid
    return
  }
  if (sampleStats.value.regular === 0) {
    errorText.value = '样本里还没有有效的常规体型量体数据，请先录入或导入再试算'
    return
  }

  running.value = true
  try {
    ensureMerged(current)
    const result = runTrial(rule.value, current.persons, options)
    archive.value = await saveTrialArchive(current, result.archive)
    expandedKeys.value = []
    message.value = `已用 ${sampleStats.value.regular} 个常规样本试算 ${result.archive.schemes.length} 套方案，耗时 ${result.durationMs} ms；试算过程已在本机留档，重开页面仍在。`
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error)
  } finally {
    running.value = false
  }
}

function toggleExpand(key: string): void {
  if (expandedKeys.value.includes(key)) expandedKeys.value = expandedKeys.value.filter((item) => item !== key)
  else expandedKeys.value = [...expandedKeys.value, key]
}

async function adopt(scheme: TrialScheme): Promise<void> {
  const current = project.value
  if (!current) return
  if (!scheme.fitsLimit) {
    errorText.value = `这一套 ${scheme.bucketCount} 档，超过工厂上限 ${archive.value?.options.maxBuckets} 档，不能采纳`
    return
  }
  const confirmed = window.confirm(
    `确认采纳这套档位？\n\n` +
      `身高步长 ${scheme.params.heightStepCm}cm、起点 ${scheme.params.heightAnchorCm}cm、胸围步长 ${scheme.params.chestStepCm}cm、${boundaryLabel(scheme.params.boundaryRule)}\n` +
      `${scheme.bucketCount} 个常规档，建议备货 ${scheme.stockQty} 套，${formatPriceFen(scheme.stockPriceFen)}\n\n` +
      `采纳后会生成一条试算规则版本并锁定到本项目，页面 / 归并 / 导出三处立即按这一套重算（同一份结果）。\n${TRIAL_POLICY_TEXT}`
  )
  if (!confirmed) return
  running.value = true
  errorText.value = ''
  try {
    const result = await adoptTrialScheme(current, scheme)
    archive.value = result.archive
    await flushProject(current)
    ensureMerged(current)
    message.value = `已采纳并写入规则内核：新版本 ${result.rule.version}。页面、归并、导出三处现在都按这一套算。`
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error)
  } finally {
    running.value = false
  }
}

function exportCsv(): void {
  const saved = archive.value
  const current = project.value
  if (!saved || !current) return
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const safeName = current.name.replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
  const fileName = `${safeName}-档位试算对照表-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.csv`
  downloadText(toCsvText(trialCompareRows(saved)), fileName)
  message.value = `已导出 ${saved.schemes.length} 套方案的对照表 → ${fileName}`
}

const genderText = (gender: string): string => (gender === 'male' ? '男' : '女')
const specialLabel = (flag: string): string => specialFlagLabel(rule.value, flag)
</script>

<template>
  <section v-if="!project" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 档位方案试算</h1>
        <div class="sub">
          拿已录入的量体数据当样本，把身高步长 / 身高起点 / 胸围步长 / 边界规则各取几种值逐套算一遍；
          选中后写进规则内核，页面、归并、导出按同一份结果算
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <RouterLink class="btn btn-sm" :to="`/merge/${project.id}`">去归并结果</RouterLink>
        <RouterLink class="btn btn-sm btn-primary" :to="`/summary/${project.id}`">去汇总</RouterLink>
      </div>
    </div>

    <div v-if="project.trialAdoption" class="card card-accent-ok">
      <div class="card-head">
        <h3>当前生效档位：试算采纳方案</h3>
        <div class="spacer"></div>
        <span class="badge badge-ok">规则版本 {{ project.trialAdoption.ruleVersion }}</span>
      </div>
      <div class="card-body tight">
        <p>
          身高步长 <b>{{ project.trialAdoption.params.heightStepCm }}cm</b>、起点
          <b>{{ project.trialAdoption.params.heightAnchorCm }}cm</b>、胸围步长
          <b>{{ project.trialAdoption.params.chestStepCm }}cm</b>、{{ boundaryLabel(project.trialAdoption.params.boundaryRule) }}；
          采纳时 {{ project.trialAdoption.bucketCount }} 档、备货 {{ project.trialAdoption.totalStock }} 套、
          {{ formatPriceFen(project.trialAdoption.totalPriceFen) }}；
          采纳人 {{ project.trialAdoption.by }}，{{ new Date(project.trialAdoption.adoptedAt).toLocaleString('zh-CN') }}。
        </p>
        <p class="hint">{{ project.trialAdoption.policyText }}</p>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>试算参数（所有档位换算一律走 0.5cm 整数，不接受小数偏移）</h2>
        <div class="spacer"></div>
        <span class="hint">基准规则：{{ rule.version }}（{{ rule.label }}）；型别区间等其余参数沿用基准规则</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">身高步长（cm，0.5 整数倍，多个用逗号分隔）<b class="req">*</b></span>
            <input v-model="form.heightStepsText" class="input" type="text" placeholder="3, 4, 5" />
          </label>
          <label class="field">
            <span class="field-label">身高起点 / 锚点（cm，0.5 整数倍）<b class="req">*</b></span>
            <input v-model="form.heightAnchorsText" class="input" type="text" placeholder="150, 155" />
          </label>
          <label class="field">
            <span class="field-label">胸围步长（cm，0.5 整数倍）<b class="req">*</b></span>
            <input v-model="form.chestStepsText" class="input" type="text" placeholder="2, 4" />
          </label>
          <label class="field">
            <span class="field-label">边界规则<b class="req">*</b></span>
            <span class="toolbar" style="min-height: 38px">
              <label class="toolbar" style="gap: 4px">
                <input v-model="form.roundUp" type="checkbox" /> 边界归上（167.5 → 170）
              </label>
              <label class="toolbar" style="gap: 4px">
                <input v-model="form.nearest" type="checkbox" /> 就近归下（167.5 → 165）
              </label>
            </span>
          </label>
          <label class="field">
            <span class="field-label">工厂能接受的档数上限（常规档）<b class="req">*</b></span>
            <input v-model.number="form.maxBuckets" class="input" type="number" min="1" step="1" />
          </label>
          <label class="field">
            <span class="field-label">每套成衣单价（元，用于算备货总价）<b class="req">*</b></span>
            <input v-model.number="form.unitPriceYuan" class="input" type="number" min="0.01" step="1" />
          </label>
          <div class="field" style="justify-content: flex-end">
            <button class="btn btn-primary" type="button" :disabled="running" @click="run">
              {{ running ? '试算中…' : '逐套试算' }}
            </button>
          </div>
        </div>

        <div class="stat-row" style="margin-top: 12px">
          <div class="stat"><div class="stat-label">样本总录入</div><div class="stat-value">{{ sampleStats.total }}</div></div>
          <div class="stat"><div class="stat-label">有效样本</div><div class="stat-value">{{ sampleStats.active }}</div></div>
          <div class="stat"><div class="stat-label">参与分桶（常规）</div><div class="stat-value">{{ sampleStats.regular }}</div></div>
          <div class="stat"><div class="stat-label">特殊单列（不占档）</div><div class="stat-value">{{ sampleStats.special }}</div></div>
          <div class="stat"><div class="stat-label">无效 / 重复排除</div><div class="stat-value">{{ sampleStats.excluded }}</div></div>
        </div>

        <p v-if="errorText" class="notice notice-error" style="margin-top: 10px">{{ errorText }}</p>
        <p v-if="message" class="notice notice-ok" style="margin-top: 10px">{{ message }}</p>
        <p class="hint" style="margin-top: 10px">
          建议备货：各档实际数量 ×（1 + 加备比例）后向上取整、每档不少于 1 套（常规 +5%，特殊单列 +10%）；
          备货总价 = 备货总套数 × 单价，金额按分整数计算。
        </p>
      </div>
    </div>

    <template v-if="archive">
      <div class="card" :class="archive.recommendedKey ? 'card-accent-ok' : 'card-accent-danger'">
        <div class="card-head">
          <h3>裁决口径与推荐</h3>
          <div class="spacer"></div>
          <button class="btn btn-sm" type="button" @click="exportCsv">导出试算对照表 CSV</button>
        </div>
        <div class="card-body tight">
          <p><b>{{ TRIAL_POLICY_TEXT }}</b></p>
          <p>
            系统推荐：<b v-if="archive.recommendedKey">{{ archive.recommendReason }}</b>
            <span v-else class="notice notice-error" style="display: inline-block">{{ archive.recommendReason }}</span>
          </p>
          <p class="hint">
            试算时间 {{ new Date(archive.createdAt).toLocaleString('zh-CN') }}｜基准规则 {{ archive.baseRuleVersion }}｜
            共 {{ archive.schemes.length }} 套参数组合，耗时 {{ archive.durationMs }} ms｜
            留档在本机 IndexedDB，重新打开仍在。
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>方案对照表（{{ archive.schemes.length }} 套，按裁决口径排序）</h2>
          <div class="spacer"></div>
          <span class="hint">多看「多出几档」换来的是最挤−最空更小（更均匀）还是备货更省</span>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="num">#</th>
                <th>标记</th>
                <th class="num">身高步长</th>
                <th class="num">身高起点</th>
                <th class="num">胸围步长</th>
                <th>边界</th>
                <th class="num">号型档数</th>
                <th class="num">档数判定</th>
                <th class="num">最挤</th>
                <th class="num">最空</th>
                <th class="num">最挤−最空</th>
                <th class="num">建议备货</th>
                <th class="num">备货总价</th>
                <th>每档人数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(scheme, index) in archive.schemes" :key="scheme.key">
                <tr :class="{ 'row-highlight': archive.adoptedKey === scheme.key }">
                  <td class="num">{{ index + 1 }}</td>
                  <td>
                    <span v-if="archive.adoptedKey === scheme.key" class="badge badge-ok">已采纳</span>
                    <span v-if="archive.recommendedKey === scheme.key" class="badge badge-info">推荐</span>
                    <span v-if="!scheme.fitsLimit" class="badge badge-danger">超上限</span>
                  </td>
                  <td class="num">{{ scheme.params.heightStepCm }}</td>
                  <td class="num">{{ scheme.params.heightAnchorCm }}</td>
                  <td class="num">{{ scheme.params.chestStepCm }}</td>
                  <td>
                    <span class="badge" :class="scheme.params.boundaryRule === 'round_up' ? 'badge-info' : 'badge-warn'">
                      {{ boundaryLabel(scheme.params.boundaryRule) }}
                    </span>
                  </td>
                  <td class="num">
                    <b>{{ scheme.bucketCount }}</b>
                    <span v-if="scheme.specialBucketCount" class="hint">（+特 {{ scheme.specialBucketCount }}）</span>
                  </td>
                  <td class="num">
                    <span class="badge" :class="scheme.fitsLimit ? 'badge-ok' : 'badge-danger'">
                      {{ scheme.fitsLimit ? `≤ ${archive.options.maxBuckets}` : `超 ${archive.options.maxBuckets}` }}
                    </span>
                  </td>
                  <td class="num">{{ scheme.busiestQty }}</td>
                  <td class="num">{{ scheme.emptiestQty }}</td>
                  <td class="num"><b>{{ scheme.spread }}</b></td>
                  <td class="num">{{ scheme.stockQty }} 套</td>
                  <td class="num"><b>{{ formatPriceFen(scheme.stockPriceFen) }}</b></td>
                  <td>
                    <button class="btn btn-sm" type="button" @click="toggleExpand(scheme.key)">
                      {{ expandedKeys.includes(scheme.key) ? '收起' : '展开各档' }}
                    </button>
                  </td>
                  <td>
                    <button
                      class="btn btn-sm btn-primary"
                      type="button"
                      :disabled="!scheme.fitsLimit || archive.adoptedKey === scheme.key"
                      @click="adopt(scheme)"
                    >
                      {{ archive.adoptedKey === scheme.key ? '本套已采纳' : '采纳这套' }}
                    </button>
                  </td>
                </tr>
                <tr v-if="expandedKeys.includes(scheme.key)">
                  <td colspan="15">
                    <div class="card-body tight">
                      <p class="hint">
                        常规 {{ scheme.regularQty }} 人分 {{ scheme.bucketCount }} 档；特殊单列 {{ scheme.specialQty }} 人 /
                        {{ scheme.specialBucketCount }} 档；胸腰差未进区间、不归桶 {{ scheme.unresolvedQty }} 人（每套相同，与档位无关）。
                      </p>
                      <div class="table-wrap">
                        <table class="data-table">
                          <thead>
                            <tr>
                              <th>号型</th>
                              <th>性别</th>
                              <th class="num">人数</th>
                              <th class="num">建议备货</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr v-for="bucket in scheme.buckets" :key="`${bucket.sizeCode}-${bucket.gender}`">
                              <td><b>{{ bucket.sizeCode }}</b></td>
                              <td>{{ genderText(bucket.gender) }}</td>
                              <td class="num">{{ bucket.qty }}</td>
                              <td class="num">{{ bucket.stock }}</td>
                            </tr>
                            <tr v-for="row in scheme.specialRows" :key="`${row.flag}-${row.gender}`">
                              <td>{{ specialLabel(row.flag) }}（{{ row.flag }}）</td>
                              <td>{{ genderText(row.gender) }}</td>
                              <td class="num">{{ row.qty }}</td>
                              <td class="num">{{ row.stock }}</td>
                            </tr>
                            <tr class="row-subtotal">
                              <td colspan="2">合计备货（常规 + 特殊）</td>
                              <td class="num">{{ scheme.regularQty + scheme.specialQty }}</td>
                              <td class="num">{{ scheme.stockQty }}</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h3>本机留档</h3>
          <div class="spacer"></div>
          <span class="badge" :class="archive.adoptedKey ? 'badge-ok' : 'badge-warn'">
            {{ archive.adoptedKey ? `已采纳 ${archive.adoptedRuleVersion}` : '仅试算，尚未采纳' }}
          </span>
        </div>
        <div class="card-body tight">
          <div class="print-meta">
            <div>试算时间：{{ new Date(archive.createdAt).toLocaleString('zh-CN') }}</div>
            <div>基准规则版本：{{ archive.baseRuleVersion }}</div>
            <div>档数上限：{{ archive.options.maxBuckets }} 档</div>
            <div>每套单价：¥{{ archive.options.unitPriceYuan }}</div>
            <div v-if="archive.adoptedAt">采纳时间：{{ new Date(archive.adoptedAt).toLocaleString('zh-CN') }}</div>
            <div v-if="archive.adoptedBy">采纳人：{{ archive.adoptedBy }}</div>
            <div v-if="archive.adoptedRuleVersion">采纳规则版本：{{ archive.adoptedRuleVersion }}</div>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
