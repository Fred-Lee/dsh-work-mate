#!/usr/bin/env node
/**
 * WorkMate 面板真机 UI 回归（headless Chromium + Playwright）
 *
 * 用途
 *   把「真机 UI 回归」从一次性临时脚本固化成仓库资产：对着**运行中的 DSH web**
 *   用真实浏览器打开 WorkMate 独立面板页，逐条验证 8 条关键交互/可访问性行为，
 *   每步截图存盘，最后打印 PASS/FAIL 汇总。断言失败退出码 1，全过 0。
 *
 * 前置（脚本不新增任何 npm 依赖，全部复用本机已有安装）
 *   1) 本机必须装好 playwright：默认从
 *      /Users/fredlee/node_modules/playwright/index.mjs 导入（绝对路径，见下方
 *      PLAYWRIGHT_PATH；导入失败会给出可读中文错误而不是裸 stack）。
 *   2) 本机 DSH web 正在运行（默认 http://127.0.0.1:3080），面板页 /workmate/ 可访问。
 *   3) token 日志可用：默认读 ~/.dsh/harness.log 里**最后一条** `token=<base64url>`，
 *      以 cookie 名 dsh_token（domain=目标 URL 的 hostname、path=/）注入浏览器上下文。
 *
 * 可选环境变量（覆盖默认值）
 *   WORKMATE_REGRESS_URL  面板地址，默认 http://127.0.0.1:3080/workmate/
 *                         （隔离宿主验证用，如 http://127.0.0.1:3081/workmate/）
 *   WORKMATE_REGRESS_LOG  token 日志路径，默认 ~/.dsh/harness.log
 *                         （隔离宿主用，如 /tmp/dsh-e2e-host.log）
 *
 * 产出
 *   截图写到仓库根的 out/e2e/（按 import.meta.url 解析，与调用 cwd 无关），
 *   文件名与断言一一对应：01-topbar-count.png … 08-task-card-tabindex.png。
 *
 * 退出码
 *   0  8 条断言全过
 *   1  至少一条断言失败（PASS/FAIL 明细见 stdout）
 *   2  环境/前置错误（playwright 导入、token 读取、目标不可达等）
 *
 * 用法
 *   node scripts/ui-regression.mjs
 *   WORKMATE_REGRESS_URL=http://127.0.0.1:3081/workmate/ \
 *     WORKMATE_REGRESS_LOG=/tmp/dsh-e2e-host.log node scripts/ui-regression.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ── 常量与配置 ─────────────────────────────────────────────────────── */

const PLAYWRIGHT_PATH = '/Users/fredlee/node_modules/playwright/index.mjs'
const DEFAULT_TARGET_URL = 'http://127.0.0.1:3080/workmate/'
const DEFAULT_LOG_PATH = path.join(os.homedir(), '.dsh', 'harness.log')
const COOKIE_NAME = 'dsh_token'
const VIEWPORT = { width: 1440, height: 900 }
const STEP_TIMEOUT = 10_000
const NAV_TIMEOUT = 20_000

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = path.join(REPO_ROOT, 'out', 'e2e')

const TARGET_URL = envOr('WORKMATE_REGRESS_URL', DEFAULT_TARGET_URL)
const TOKEN_LOG_PATH = envOr('WORKMATE_REGRESS_LOG', DEFAULT_LOG_PATH)

/* ── 通用小工具 ─────────────────────────────────────────────────────── */

function envOr(name, fallback) {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 环境/前置错误：打印可读中文说明，退出码 2，不抛裸 stack。 */
class UsageError extends Error {}

/** 断言失败：携带期望/实际值，交给汇总表格式化。 */
class CheckFailure extends Error {
  constructor(expected, actual, hint) {
    super(hint ?? `期望 ${expected}，实际 ${formatValue(actual)}`)
    this.expected = expected
    this.actual = actual
    this.hint = hint
  }
}

function expect(condition, expected, actual, hint) {
  if (condition !== true) throw new CheckFailure(expected, actual, hint)
}

/* ── 前置：playwright / token / 目标 URL ───────────────────────────── */

async function loadChromium() {
  if (!fs.existsSync(PLAYWRIGHT_PATH)) {
    throw new UsageError(
      `找不到 playwright：${PLAYWRIGHT_PATH}\n` +
        '  本机需安装 playwright（本仓库不新增 npm 依赖，脚本按绝对路径复用全局安装），\n' +
        '  或修改 scripts/ui-regression.mjs 顶部的 PLAYWRIGHT_PATH。',
    )
  }
  let module
  try {
    module = await import(pathToFileURL(PLAYWRIGHT_PATH).href)
  } catch (cause) {
    throw new UsageError(
      `playwright 导入失败：${PLAYWRIGHT_PATH}\n` +
        `  原因：${cause instanceof Error ? cause.message : String(cause)}\n` +
        '  本机需安装 playwright（仓库不新增 npm 依赖），或调整脚本内的 PLAYWRIGHT_PATH。',
    )
  }
  const chromium = module.chromium ?? module.default?.chromium
  if (chromium === undefined) {
    throw new UsageError(
      `playwright 模块没有导出 chromium：${PLAYWRIGHT_PATH}\n` +
        '  请确认该路径指向 playwright 的 ESM 入口（预期导出 { chromium }）。',
    )
  }
  return chromium
}

/** 从日志里取最后一条 `token=<base64url>`；缺失/为空都给可读错误。 */
function readToken(logPath) {
  if (!fs.existsSync(logPath)) {
    throw new UsageError(
      `token 日志不存在：${logPath}\n` +
        '  token 由运行中的 DSH web 写入该日志（最后一条 `token=<base64url>`）；\n' +
        '  请先启动 `dsh web`，或用 WORKMATE_REGRESS_LOG 指向正确的日志文件。',
    )
  }
  let content
  try {
    content = fs.readFileSync(logPath, 'utf8')
  } catch (cause) {
    throw new UsageError(
      `token 日志读取失败：${logPath}\n  原因：${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const matches = [...content.matchAll(/token=([A-Za-z0-9_-]+)/g)]
  if (matches.length === 0) {
    throw new UsageError(
      `token 日志里没有 token=<base64url> 行：${logPath}\n` +
        '  日志里应至少有一条 DSH web 启动时打印的 token（面板鉴权用）。',
    )
  }
  return matches[matches.length - 1][1]
}

function parseTarget(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UsageError(`WORKMATE_REGRESS_URL 不是合法 URL：${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UsageError(`WORKMATE_REGRESS_URL 必须是 http(s) 地址：${rawUrl}`)
  }
  return url
}

/* ── 浏览器侧小 helper（每个断言步骤都由这些拼起来） ───────────────── */

/** @type {import('playwright').Page} */
let page

const checks = []
const shots = new Set()

const diagnostics = {
  pageErrors: [],
  consoleErrors: [],
}

/**
 * 轮询直到 fn 返回「非 null/undefined/false」的值；超时抛出带标签的可读错误。
 * 用它替代成片的 waitForTimeout：既不等死固定时长，也不因一次抖动就判失败。
 */
async function waitUntil(fn, label, timeout = STEP_TIMEOUT, interval = 100) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await fn()
    if (value !== null && value !== undefined && value !== false) return value
    await delay(interval)
  }
  throw new Error(`等待超时（${timeout}ms）：${label}`)
}

const countOf = (selector) => page.evaluate((query) => document.querySelectorAll(query).length, selector)

/** 等两帧渲染稳定（滚动/布局后截图前用），不靠固定 sleep。 */
const settleFrames = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))

/** 把某个节点滚进视口并等两帧，让截图能看到断言目标。 */
async function scrollIntoViewAndSettle(selector) {
  await page.evaluate((query) => {
    document.querySelector(query)?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, selector)
  await settleFrames()
}

const textOf = (selector) =>
  page.evaluate((query) => document.querySelector(query)?.textContent?.trim() ?? null, selector)


/** 截图到 out/e2e/，并拒绝空文件（产物必须非空才算留证）。 */
async function shot(name, options = {}) {
  const file = path.join(OUT_DIR, name)
  await page.screenshot({ path: file, ...options })
  const size = fs.statSync(file).size
  if (size === 0) throw new Error(`截图产物为空：${file}`)
  shots.add(name)
  return file
}

/** 点顶栏 Segmented 切视图，并等该视图的标志性节点出现。 */
async function switchView(label, markerSelector) {
  const tab = page.getByRole('tab', { name: label, exact: true })
  await tab.waitFor({ state: 'visible', timeout: STEP_TIMEOUT })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await waitUntil(() => page.evaluate((query) => document.querySelector(query) !== null, markerSelector), `切换到「${label}」视图（等待 ${markerSelector}）`)
}

/* ── 断言步骤 ────────────────────────────────────────────────────────── */

/** ① 顶栏计数含「（含已归档）」：加载失败态是「— 条提案」，不能被当成通过。 */
async function stepTopbarCount(check, expectedCount) {
  const countText = await waitUntil(async () => {
    const text = await textOf('.wm-count')
    if (text === null || !text.includes('（含已归档）')) return null
    if (expectedCount !== null) {
      // 首屏 API 已返回 N 条提案：等计数真的渲染成 N，别把初始「0 条提案」当通过。
      const match = text.match(/^(\d+) 条提案（含已归档）$/)
      if (match === null || Number(match[1]) !== expectedCount) return null
    }
    return text
  }, expectedCount === null
    ? '顶栏 .wm-count 渲染出「（含已归档）」'
    : `顶栏 .wm-count 渲染出「${expectedCount} 条提案（含已归档）」（与首屏 API 返回的提案数一致）`)
  check.detail = `.wm-count = ${formatValue(countText)}`
  await shot('01-topbar-count.png')
  expect(countText.includes('（含已归档）'), '顶栏计数包含「（含已归档）」', countText)
  expect(countText !== '— 条提案', '顶栏计数不是加载失败态「— 条提案」', countText)
}

/** ② 「显示已归档」pill 点击后 aria-pressed false → true，并恢复关闭。 */
async function readArchivePill() {
  return page.evaluate(() => {
    const pill = [...document.querySelectorAll('button.wm-pill')].find((element) => element.textContent.trim().includes('已归档'))
    return pill === undefined
      ? null
      : { text: pill.textContent.trim(), pressed: pill.getAttribute('aria-pressed') }
  })
}

async function stepArchivePill(check) {
  const before = await waitUntil(async () => {
    const pill = await readArchivePill()
    return pill !== null && pill.pressed === 'false' ? pill : null
  }, '「显示已归档」pill 出现且 aria-pressed=false')
  let after = null
  try {
    await page.locator('button.wm-pill', { hasText: '显示已归档' }).click()
    after = await waitUntil(async () => {
      const pill = await readArchivePill()
      return pill !== null && pill.pressed === 'true' ? pill : null
    }, '点击「显示已归档」后 aria-pressed 变为 true')
    check.detail = `pill = ${formatValue(before.text)}；aria-pressed: ${before.pressed} → ${after.pressed}`
    await shot('02-archived-pill.png')
    expect(after.pressed === 'true', '点击后 aria-pressed=true', after)
    expect(after.text.includes('隐藏已归档'), '点击后 pill 文案变为「隐藏已归档」', after.text)
  } finally {
    // 恢复关闭：后续步骤依赖 showArchived=false（看板隐藏计数/列表默认筛选）。
    const restore = page.locator('button.wm-pill', { hasText: '隐藏已归档' })
    if ((await restore.count()) > 0) await restore.click()
    await waitUntil(async () => (await readArchivePill())?.pressed === 'false', '关闭已归档后 pill 恢复 aria-pressed=false', 5000)
  }
}

/** ③ 列表搜索无结果：空态含「清空筛选」按钮，点击后列表恢复出行。 */
async function stepListSearchEmpty(check) {
  await switchView('列表', '.wm-list')
  try {
    await page.locator('.wm-search').fill('绝对不存在的关键词zzz')
    const empty = await waitUntil(async () => {
      return page.evaluate(() => {
        const box = document.querySelector('.wm-empty')
        if (box === null) return null
        const text = box.textContent.trim()
        const hasClear = [...box.querySelectorAll('button')].some((button) => button.textContent.includes('清空筛选'))
        return { text, hasClear }
      })
    }, '搜索无结果时出现空态')
    check.detail = `.wm-empty = ${formatValue(empty.text)}；含「清空筛选」= ${empty.hasClear}`
    await shot('03-list-search-empty.png')
    expect(empty.hasClear, '空态含「清空筛选」按钮', empty.text)
    expect(empty.text.includes('没有匹配的提案'), '空态文案说明「没有匹配的提案」', empty.text)
    await page.locator('.wm-empty button', { hasText: '清空筛选' }).click()
    const restoredRows = await waitUntil(async () => {
      const count = await countOf('.wm-list-row')
      return count > 0 ? count : null
    }, '点击「清空筛选」后列表恢复出行（.wm-list-row）')
    check.detail += `；清空后行数 = ${restoredRows}`
    expect(restoredRows > 0, '点击「清空筛选」后 .wm-list-row 行数 > 0', restoredRows)
  } finally {
    // 恢复筛选状态：搜索词残留会让后续 ④⑤ 级联变红（④ 的隐藏计数依赖 visibleProposals）。
    const search = page.locator('.wm-search')
    const current = await search.inputValue().catch(() => '')
    if (current !== '') {
      await search.fill('')
      await waitUntil(async () => (await countOf('.wm-list-row')) > 0, '清空搜索后列表恢复出行', 5000).catch(() => {})
    }
  }
}

/** ④ 看板「已归档」列的隐藏计数含「已归档」与「已终止」两段。 */
async function stepBoardHiddenCount(check) {
  await switchView('看板', '.wm-board')
  const hidden = await waitUntil(async () => {
    return page.evaluate(() => {
      const box = [...document.querySelectorAll('.wm-col-empty')].find((element) => element.textContent.includes('已隐藏'))
      return box === undefined ? null : { text: box.textContent.trim() }
    })
  }, '看板「已归档」列出现隐藏计数（.wm-col-empty 含「已隐藏」）')
  check.detail = `.wm-col-empty = ${formatValue(hidden.text)}`
  await shot('04-board-hidden-count.png')
  expect(hidden.text.includes('已隐藏'), '看板隐藏计数含「已隐藏」', hidden.text)
  expect(hidden.text.includes('已归档'), '看板隐藏计数含「已归档」一段', hidden.text)
  expect(hidden.text.includes('已终止'), '看板隐藏计数含「已终止」一段', hidden.text)
}

/** ⑤ 提案抽屉含「做了什么」段；事件行以 MM-DD HH:mm 开头且 kind 为中文。 */
async function stepDrawerEvidence(check) {
  await switchView('列表', '.wm-list')
  const rowCount = await waitUntil(async () => {
    const count = await countOf('.wm-list-row')
    return count > 0 ? count : null
  }, '列表有可点击的提案行（.wm-list-row）')

  const attempts = Math.min(rowCount, 4)
  let opened = null
  try {
    for (let index = 0; index < attempts; index += 1) {
      await page.locator('.wm-list-row').nth(index).click()
      try {
        // 抽屉详情异步加载：先等「做了什么」段出现，再等事件行异步填充。
        const base = await waitUntil(async () => {
          return page.evaluate(() => {
            const drawer = document.querySelector('.wm-drawer')
            if (drawer === null) return null
            const sections = [...drawer.querySelectorAll('.wm-drawer-section')].map((node) => node.textContent.trim())
            return sections.length > 0 ? { sections, title: drawer.querySelector('h3')?.textContent?.trim() ?? '' } : null
          })
        }, `第 ${index + 1} 个列表行的抽屉详情加载（.wm-drawer）`)
        const events = await waitUntil(async () => {
          return page.evaluate(() => {
            const drawer = document.querySelector('.wm-drawer')
            const rows = [...drawer.querySelectorAll('.wm-team-events .wm-action-note')].map((node) => node.textContent.trim())
            return rows.length > 0 ? rows : null
          })
        }, `第 ${index + 1} 个列表行的事件异步加载（.wm-team-events .wm-action-note）`, 4000)
        opened = { ...base, events, rowIndex: index }
        break
      } catch {
        // 该行没有事件或详情加载失败：关掉抽屉换下一行（只读操作，无状态残留）。
        await page.keyboard.press('Escape')
        await waitUntil(async () => (await countOf('.wm-drawer')) === 0, 'Escape 关闭抽屉', 3000).catch(() => {})
      }
    }
    expect(opened !== null, `前 ${attempts} 个列表行里至少一行抽屉能加载出事件行`, opened)
    const eventLine = opened.events[0]
    const match = eventLine.match(/^(\d{2}-\d{2} \d{2}:\d{2}) · (.+)$/)
    const kindText = match === null ? '' : match[2]
    check.detail =
      `抽屉「${opened.title}」段=[${opened.sections.join(' / ')}]；` +
      `事件行（${opened.events.length} 条）首行 = ${formatValue(eventLine)}`
    // 截图要能看到断言目标：把事件列表滚进视口再拍。
    await scrollIntoViewAndSettle('.wm-team-events')
    await shot('05-drawer-work-events.png')
    expect(opened.sections.includes('做了什么'), '抽屉含「做了什么」段', opened.sections)
    expect(match !== null, '事件行以 MM-DD HH:mm 时间开头（形如 11-13 18:36 · kind）', eventLine)
    expect(/^[\u4e00-\u9fff]/.test(kindText), '事件行的 kind 为中文', kindText)
  } finally {
    if ((await countOf('.wm-drawer')) > 0) {
      await page.keyboard.press('Escape')
      await waitUntil(async () => (await countOf('.wm-drawer')) === 0, 'Escape 关闭抽屉', 3000).catch(() => {})
    }
  }
}

/** ⑥ 控制台 KPI 有「活跃提案」；bands insufficient 行的 note 为中文。 */
async function stepConsoleBands(check) {
  await switchView('控制台', '.wm-console')
  await waitUntil(async () => (await countOf('.wm-kpi-label')) > 0, '控制台 KPI 渲染（.wm-kpi-label）')
  const info = await waitUntil(async () => {
    return page.evaluate(() => {
      const labels = [...document.querySelectorAll('.wm-kpi-label')].map((node) => node.textContent.trim())
      const rows = [...document.querySelectorAll('.wm-table tr')]
      const row = rows.find((tr) => tr.querySelector('.wm-tier-unknown')?.textContent?.trim().includes('数据不足'))
      if (row === undefined) return null
      const cells = [...row.querySelectorAll('td')]
      const lastCell = cells[cells.length - 1]
      return {
        labels,
        metric: cells[0]?.textContent?.trim() ?? '',
        tier: row.querySelector('.wm-tier-unknown')?.textContent?.trim() ?? '',
        // 注意：同行的指标单元格里还有一个主题 note（「越大越差/越小越差」），
        // 必须取**最后一列**里的 note 才是 bands 的 insufficient 说明。
        note: lastCell?.querySelector('.wm-kpi-note')?.textContent?.trim() ?? null,
      }
    })
  }, '控制带表出现「数据不足」行（等待 /workmate/api/bands）')
  check.detail =
    `KPI 标签 = [${info.labels.join(' / ')}]；` +
    `insufficient 行 = ${formatValue(info.metric)} ${formatValue(info.tier)}，note = ${formatValue(info.note)}`
  // 整页截图：顶部 KPI（「活跃提案」）与底部控制带 insufficient 行的中文 note 同框，
  // 一张图就能复核 ⑥ 的两个断言目标。
  await shot('06-console-kpi-bands.png', { fullPage: true })
  expect(info.labels.some((label) => label.includes('活跃提案')), '控制台 KPI 含「活跃提案」', info.labels)
  expect(info.tier.includes('数据不足'), '控制带表存在「数据不足」行', info.tier)
  expect(info.note !== null && info.note !== '', 'insufficient 行有 note', info.note)
  expect(info.note !== null && /[\u4e00-\u9fff]/.test(info.note), 'insufficient 行 note 为中文', info.note)
}

/** ⑦ 新提案模态 role=dialog；空标题点「下一步」出现「先填标题」；Escape 关闭。 */
async function stepCreateModal(check) {
  await page.locator('.wm-header').getByRole('button', { name: /新提案/ }).click()
  const modal = await waitUntil(async () => {
    return page.evaluate(() => {
      const box = document.querySelector('.wm-modal-box')
      return box === null
        ? null
        : { role: box.getAttribute('role'), ariaModal: box.getAttribute('aria-modal'), heading: box.querySelector('h3')?.textContent?.trim() ?? '' }
    })
  }, '新提案模态出现（.wm-modal-box）')
  try {
    await page.locator('.wm-modal-box').getByRole('button', { name: '下一步', exact: true }).click()
    const errorNote = await waitUntil(async () => {
      const text = await page.evaluate(() => document.querySelector('.wm-modal-box .wm-error-note')?.textContent?.trim() ?? null)
      return text !== null && text !== '' ? text : null
    }, '空标题点「下一步」后出现校验提示（.wm-error-note）')
    check.detail = `模态 role=${formatValue(modal.role)} aria-modal=${formatValue(modal.ariaModal)}；校验提示 = ${formatValue(errorNote)}`
    await shot('07-new-proposal-validation.png')
    expect(modal.role === 'dialog', '新提案模态 role=dialog', modal.role)
    expect(modal.ariaModal === 'true', '新提案模态 aria-modal=true', modal.ariaModal)
    expect(errorNote.includes('先填标题'), '空标题点「下一步」出现「先填标题」', errorNote)
  } finally {
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await countOf('.wm-modal-box')) === 0, 'Escape 关闭新提案模态', 3000).catch(() => {})
  }
}

/** ⑧ 任务视图的卡片是 <article tabindex="0">（可键盘聚焦）。 */
async function stepTaskCard(check) {
  await switchView('任务', '.wm-task-card')
  const card = await waitUntil(async () => {
    return page.evaluate(() => {
      const element = document.querySelector('.wm-task-card')
      return element === null ? null : { tag: element.tagName, tabIndex: element.getAttribute('tabindex') }
    })
  }, '任务视图出现任务卡片（.wm-task-card）')
  check.detail = `.wm-task-card = <${card.tag.toLowerCase()} tabindex=${formatValue(card.tabIndex)}>`
  await shot('08-task-card-tabindex.png')
  expect(card.tag === 'ARTICLE', '任务卡片标签为 <article>', card.tag)
  expect(card.tabIndex === '0', '任务卡片 tabIndex=0', card.tabIndex)
}

/* ── 执行与汇总 ──────────────────────────────────────────────────────── */

/**
 * 失败明细：期望 / 实际 + 调用方给的附加说明。期望与实际只由这里格式化一次，
 * 避免「期望：X；实际：Y；期望 X，实际 Y」的重复输出。
 */
function describeFailure(check) {
  const parts = []
  if (check.expected !== null) parts.push(`期望 ${formatValue(check.expected)}`)
  if (check.actual !== null) parts.push(`实际 ${formatValue(check.actual)}`)
  if (check.detail !== '') parts.push(check.detail)
  return parts.join('；')
}

/**
 * 跑一条断言：收集 PASS/FAIL、保证该步有截图（步骤内抛错时补拍当前画面）。
 */
async function runCheck(id, title, shotName, body) {
  const check = { id, title, ok: true, detail: '', expected: null, actual: null, shotPath: null }
  try {
    await body(check)
  } catch (cause) {
    check.ok = false
    if (cause instanceof CheckFailure) {
      check.expected = cause.expected
      check.actual = cause.actual
      check.detail = cause.hint ?? ''
    } else {
      check.detail = `步骤异常：${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  try {
    const file = path.join(OUT_DIR, shotName)
    if (!shots.has(shotName)) {
      await page.screenshot({ path: file })
      shots.add(shotName)
    }
    check.shotPath = file
  } catch (cause) {
    check.ok = false
    check.detail = `${check.detail}${check.detail === '' ? '' : '；'}截图失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
  checks.push(check)
  const suffix = check.ok ? check.detail : describeFailure(check)
  console.log(`${check.ok ? 'PASS' : 'FAIL'} ${id} ${title}${suffix === '' ? '' : ` — ${suffix}`}`)
  return check
}

function attachDiagnostics(target) {
  target.on('pageerror', (error) => diagnostics.pageErrors.push(String(error)))
  target.on('console', (message) => {
    // console error 只报告不计入失败：面板宿主侧的日志噪音不该让回归变脆。
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text())
  })
}

function printDiagnostics() {
  if (diagnostics.pageErrors.length > 0) {
    console.log(`\n⚠ pageerror（${diagnostics.pageErrors.length} 条，单独报告，不计入断言失败）：`)
    for (const line of diagnostics.pageErrors) console.log(`  - ${line}`)
  }
  if (diagnostics.consoleErrors.length > 0) {
    console.log(`\n⚠ console error（${diagnostics.consoleErrors.length} 条，不计入断言失败）：`)
    for (const line of diagnostics.consoleErrors.slice(0, 10)) console.log(`  - ${line}`)
    if (diagnostics.consoleErrors.length > 10) console.log(`  … 省略 ${diagnostics.consoleErrors.length - 10} 条`)
  }
}

function printSummary(target) {
  const passed = checks.filter((check) => check.ok).length
  const failed = checks.length - passed
  console.log('\n=== WorkMate UI 回归汇总 ===')
  console.log(`目标：${target.href}`)
  console.log(`token 日志：${TOKEN_LOG_PATH}`)
  console.log(`截图目录：${OUT_DIR}`)
  for (const check of checks) {
    if (check.ok) {
      console.log(`PASS ${check.id} ${check.title}`)
    } else {
      console.log(`FAIL ${check.id} ${check.title} — ${describeFailure(check)}`)
    }
  }
  for (const check of checks) {
    const name = check.shotPath === null ? '（无截图）' : path.relative(OUT_DIR, check.shotPath)
    console.log(`  截图 ${check.id} → ${name}`)
  }
  console.log(`\n结果：${passed}/${checks.length} 通过${failed > 0 ? `，${failed} 失败` : ''}（截图 ${shots.size} 张）`)
  printDiagnostics()
  return failed
}

async function main() {
  const chromium = await loadChromium()
  const token = readToken(TOKEN_LOG_PATH)
  const target = parseTarget(TARGET_URL)
  fs.mkdirSync(OUT_DIR, { recursive: true })

  let browser
  try {
    try {
      browser = await chromium.launch({ headless: true })
    } catch (cause) {
      throw new UsageError(
        `Chromium 启动失败：${cause instanceof Error ? cause.message : String(cause)}\n` +
          '  本机需安装 playwright 的浏览器内核：npx playwright install chromium。',
      )
    }
    const context = await browser.newContext({ viewport: VIEWPORT })
    await context.addCookies([{ name: COOKIE_NAME, value: token, domain: target.hostname, path: '/' }])
    page = await context.newPage()
    page.setDefaultTimeout(STEP_TIMEOUT)
    page.setDefaultNavigationTimeout(NAV_TIMEOUT)
    attachDiagnostics(page)

    console.log(`WorkMate UI 回归 → ${target.href}`)
    console.log(`token 日志：${TOKEN_LOG_PATH}`)
    console.log(`截图目录：${OUT_DIR}\n`)

    // 首屏数据就绪：面板挂载即 GET /workmate/api/proposals。先等这次响应再断言，
    // 否则顶栏可能停在初始的「0 条提案（含已归档）」，截图与明细都会误导。
    const initialProposals = page
      .waitForResponse(
        (response) => response.url().includes('/workmate/api/proposals') && response.request().method() === 'GET',
        { timeout: STEP_TIMEOUT },
      )
      .catch(() => undefined)

    try {
      await page.goto(target.href, { waitUntil: 'domcontentloaded' })
    } catch (cause) {
      throw new UsageError(
        `无法打开 ${target.href}：${cause instanceof Error ? cause.message : String(cause)}\n` +
          '  请确认目标 DSH web 正在运行（默认 http://127.0.0.1:3080），或用 WORKMATE_REGRESS_URL 指定。',
      )
    }

    // 首屏提案响应到了再开始断言（超时不阻塞；后续每条断言仍各自等待自己的数据，
    // 等待超时会给可读原因）。这样 ① 的明细与截图不会停在「0 条提案」初始态。
    const proposalsResponse = await initialProposals
    let expectedProposalCount = null
    if (proposalsResponse !== undefined) {
      try {
        const payload = await proposalsResponse.json()
        const list = Array.isArray(payload?.proposals) ? payload.proposals : []
        if (list.length > 0) expectedProposalCount = list.length
      } catch {
        // 响应体不可解析（形状漂移）：退回只校验文案，不因此失败。
        expectedProposalCount = null
      }
    }

    await runCheck('①', '顶栏计数含「（含已归档）」', '01-topbar-count.png', (check) =>
      stepTopbarCount(check, expectedProposalCount),
    )
    await runCheck('②', '「显示已归档」pill 点击后 aria-pressed false→true', '02-archived-pill.png', stepArchivePill)
    await runCheck('③', '列表搜索无结果空态含「清空筛选」且点击可恢复', '03-list-search-empty.png', stepListSearchEmpty)
    await runCheck('④', '看板隐藏计数含「已归档」与「已终止」两段', '04-board-hidden-count.png', stepBoardHiddenCount)
    await runCheck('⑤', '抽屉含「做了什么」段、事件行 MM-DD HH:mm + 中文 kind', '05-drawer-work-events.png', stepDrawerEvidence)
    await runCheck('⑥', '控制台 KPI 有「活跃提案」且 bands insufficient 行有中文 note', '06-console-kpi-bands.png', stepConsoleBands)
    await runCheck('⑦', '新提案模态 role=dialog 且空标题点「下一步」出现「先填标题」', '07-new-proposal-validation.png', stepCreateModal)
    await runCheck('⑧', '任务卡片 article tabIndex=0', '08-task-card-tabindex.png', stepTaskCard)

    const failed = printSummary(target)
    process.exitCode = failed === 0 ? 0 : 1
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
  }
}

main().catch((cause) => {
  if (cause instanceof UsageError) {
    console.error(`\n❌ 前置检查失败：${cause.message}`)
    process.exitCode = 2
    return
  }
  console.error(`\n❌ 回归脚本异常终止：${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`)
  process.exitCode = 2
})