/* 集成自检：最小内存 IndexedDB 下验证 留档 → 采纳写核 → 项目切换 → 再归并同源 */
import assert from 'node:assert'

/* -------- 最小内存 indexedDB shim（只覆盖应用用到的 API） -------- */
type Store = Map<string, any>
const stores = new Map<string, Store>()

function makeRequest(target: any, result: any) {
  return { result, error: null, onsuccess: null as any, onerror: null as any }
}

class FakeTx {
  objectStore(name: string) {
    const store = stores.get(name)!
    return {
      put(value: any) {
        const req = makeRequest(null, undefined)
        queueMicrotask(() => {
          store.set(value[name === 'projects' ? 'id' : name === 'rules' ? 'version' : name === 'trials' ? 'projectId' : 'key'], structuredClone(value))
          req.onsuccess?.()
        })
        return req
      },
      get(key: string) {
        const req = makeRequest(null, undefined)
        queueMicrotask(() => {
          req.result = structuredClone(store.get(key))
          req.onsuccess?.()
        })
        return req
      },
      getAll() {
        const req = makeRequest(null, undefined)
        queueMicrotask(() => {
          req.result = [...store.values()].map((value) => structuredClone(value))
          req.onsuccess?.()
        })
        return req
      },
      delete(key: string) {
        const req = makeRequest(null, undefined)
        queueMicrotask(() => {
          store.delete(key)
          req.onsuccess?.()
        })
        return req
      },
      count() {
        const req = makeRequest(null, store.size)
        queueMicrotask(() => req.onsuccess?.())
        return req
      }
    }
  }
  oncomplete: any = null
  onerror: any = null
  onabort: any = null
}

;(globalThis as any).indexedDB = {
  open() {
    const request: any = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null }
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: (name: string) => stores.has(name) },
        transaction(names: string | string[], _mode: string) {
          const list = Array.isArray(names) ? names : [names]
          for (const name of list) if (!stores.has(name)) stores.set(name, new Map())
          const tx = new FakeTx() as any
          const origStore = tx.objectStore.bind(tx)
          let pending = 0
          tx.objectStore = (name: string) => {
            const bound = origStore(name)
            const wrap = (fnName: string) => {
              const orig = bound[fnName].bind(bound)
              return (...args: any[]) => {
                pending += 1
                const req = orig(...args)
                const oldSuccess = req.onsuccess
                req.onsuccess = (event: any) => {
                  oldSuccess?.(event)
                  pending -= 1
                  if (pending === 0) queueMicrotask(() => tx.oncomplete?.(event))
                }
                return req
              }
            }
            return new Proxy(bound, {
              get(target, prop) {
                if (['put', 'get', 'getAll', 'delete'].includes(prop as string)) return wrap(prop as string)
                return target[prop as any]
              }
            })
          }
          return tx
        }
      }
      if (!stores.has('projects')) {
        stores.set('projects', new Map())
        stores.set('rules', new Map())
        stores.set('meta', new Map())
        stores.set('trials', new Map())
      }
      request.onupgradeneeded?.()
      request.onsuccess?.()
    })
    return request
  }
}
;(globalThis as any).performance = globalThis.performance

/* -------- Vue reactive shim：store.ts/trialStore.ts 用到 reactive/ref/toRaw -------- */
import { createRequire } from 'node:module'
// 通过 esbuild 打包后 vue 会被内联进来，这里不需要真的 vue（应用逻辑在 store.ts 用了 reactive）

/* -------- 实际链路 -------- */
const { runTrial, paramsOfRule } = await import('./src/logic/trial')
const { loadTrial, saveTrial, adoptTrialScheme, nextTrialVersion } = await import('./src/logic/trialStore')
const { runMerge, buildSummary } = await import('./src/logic/merge')
const { BUILTIN_RULES } = await import('./src/logic/sizeRules')
const { idbGetAll, STORE_RULES } = await import('./src/logic/idb')

function makePerson(i: number, heightCm: number, chestCm: number, waistCm: number, extra: any = {}) {
  return {
    id: `p_${i}`, name: `样本${i}`, gender: 'male', orgUnit: '一班', batch: '',
    heightCm, weightKg: null, chestCm, waistCm, specialFlag: null, note: '',
    status: 'active', statusReason: '', anomaly: [], needsConfirm: false,
    possibleDuplicateOf: null, sourceRow: i + 1, source: 'manual', result: null,
    createdAt: 0, ...extra
  }
}

const persons: any[] = []
for (let n = 0; n < 20; n++) persons.push(makePerson(n, 162 + (n % 2) * 1.5, 86, 72))
for (let n = 0; n < 20; n++) persons.push(makePerson(20 + n, 176 + (n % 2) * 1.5, 96, 82))
const project: any = {
  id: 'prj_flow', name: '流程自检学校', kind: 'school',
  ruleVersion: BUILTIN_RULES[0].version, batches: [], persons, imports: [], createdAt: 0, updatedAt: 0
}

const rules = [...BUILTIN_RULES]
const config = {
  heightStepsCm: [3, 5],
  heightAnchorsCm: [153, 155],
  chestStepsCm: [4],
  boundaryRules: ['round_up', 'nearest'] as any,
  maxBins: 40,
  unitPrice: 100
}

// 1) 试算并留档
const record = runTrial(project, BUILTIN_RULES[0], config)
assert.equal(record.schemes.length, 8)
await saveTrial(record)

// 2) 重新打开（模拟）：留档还在
const reopened = await loadTrial(project.id)
assert.ok(reopened, '试算记录必须从本机存储读回')
assert.equal(reopened!.schemes.length, 8)
console.log('✓ 试算过程写入本机留档，重新打开仍在（8 套）')

// 3) 采纳推荐方案
const recommended = reopened!.schemes.find((s) => s.id === reopened!.recommendedSchemeId)!
const version = nextTrialVersion(rules)
assert.equal(version, 'trial-1')
const { rule: newRule } = await adoptTrialScheme({
  project,
  baseRule: reopened!.baseRule,
  scheme: recommended,
  record: reopened!,
  version,
  label: '流程自检采纳',
  effectiveFrom: '2026-10-05',
  existingRules: rules
})
assert.equal(newRule.heightStepCm, recommended.params.heightStepCm)
assert.equal(newRule.heightAnchor, recommended.params.heightAnchorCm)
assert.equal(newRule.chestStepCm, recommended.params.chestStepCm)
assert.equal(newRule.boundaryRule, recommended.params.boundaryRule)
assert.equal(newRule.builtin, false)
assert.equal(project.ruleVersion, 'trial-1')
console.log('✓ 采纳：选中参数写进规则内核 trial-1，项目锁定新版本')

// 4) 内核规则持久化进 IDB
const persistedRules = await idbGetAll<any>(STORE_RULES)
assert.ok(persistedRules.some((r) => r.version === 'trial-1'))
console.log('✓ 新规则版本已落盘，重开后规则内核包含 trial-1')

// 5) 留档里选中结果也更新了
const reopened2 = await loadTrial(project.id)
assert.equal(reopened2!.selectedSchemeId, recommended.id)
assert.equal(reopened2!.selectedRuleVersion, 'trial-1')
console.log('✓ 留档标记选中方案与采纳版本')

// 6) 按新规则重新归并，结果与试算 bins 完全同源
runMerge(project, newRule)
const summary = buildSummary(project.persons, newRule)
const trialBins = new Map(recommended.bins.map((b: any) => [`${b.isSpecial}-${b.sizeCode}-${b.gender}`, b]))
assert.equal(summary.allRows.length, recommended.bins.length)
let totalQty = 0
for (const row of summary.allRows) {
  const bin = trialBins.get(`${row.isSpecial}-${row.sizeCode}-${row.gender}`)
  assert.ok(bin, `归并出现试算里没有的档：${row.sizeCode}`)
  assert.equal(bin.qty, row.qty)
  totalQty += row.qty
}
assert.equal(totalQty, 40)
console.log('✓ 页面/归并/导出同一份结果：采纳后 buildSummary 与试算 bins 逐档一致（40 人）')

// 7) 型别区间等沿用基础版本，没有被档位参数覆盖影响
assert.deepEqual(newRule.fitByChestWaistDiff, BUILTIN_RULES[0].fitByChestWaistDiff)
assert.equal(newRule.chestAnchor, BUILTIN_RULES[0].chestAnchor)
console.log('✓ 采纳只改四项档位参数，型别区间/特殊标记/胸围锚点沿用基础版本')

// 8) 项目当前参数 == 推荐方案参数
assert.deepEqual(paramsOfRule(newRule), recommended.params)
console.log('✓ 规则内核参数与选中方案严格一致')

console.log('\n集成链路自检通过：试算 → 留档（重开还在）→ 采纳写核 → 三处同源')
