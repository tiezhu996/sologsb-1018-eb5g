import type { Attempt, GroupTiming, PracticeProject, SenseGroup } from './types'

const TICK = 0.1
const MIN_SEGMENT = 0.1
const EPS = 1e-6

/** 估算权重：字数（去掉标点空白），英文单词按词计，中文按字计。 */
export function spokenCount(text: string): number {
  return (text.match(/[A-Za-z0-9']+|[一-鿿]/g) ?? []).length
}

/** 语速（秒/字）：从本次录音时长里扣除全部停顿后反推；停顿吃光时长时退化为经验语速。 */
function secondsPerChar(groups: SenseGroup[], duration: number): number {
  const chars = groups.reduce((sum, group) => sum + spokenCount(group.text), 0)
  if (chars <= 0) return 0.24
  const pauseTotal = groups.reduce((sum, group) => sum + group.pauseMs, 0) / 1000
  const speechTime = duration - pauseTotal
  if (speechTime >= chars * 0.05) return speechTime / chars
  return duration / Math.max(chars, 1)
}

/**
 * 意群权重 = 字数 * 语速 + 后接停顿。最后一段后面没有停顿，不计入权重
 * （停顿时长保留在倒数第二段的尾部）。
 */
function weightOf(group: SenseGroup, index: number, groups: SenseGroup[], secPerChar: number): number {
  const chars = spokenCount(group.text)
  const pause = index < groups.length - 1 ? group.pauseMs / 1000 : 0
  return Math.max(chars * secPerChar + pause, EPS)
}

/**
 * 在若干互不重叠的时间空隙里分配未锁定段，边界落在 0.1s 刻度上。每段严格位于单个空隙内，
 * 绝不跨过锁定锚点。先按各空隙时长占比（最大余数法）决定每个空隙放几段，文字顺序靠前的段
 * 进入时间靠前的空隙；空隙内再按权重（字数 + 后接停顿）比例切分，空隙末尾取齐。
 */
function fillGaps(
  groups: SenseGroup[],
  unlockedIndexes: number[],
  gaps: Array<{ from: number; to: number }>,
  secPerChar: number,
  result: Map<string, GroupTiming>
): void {
  const usable = gaps.filter((gap) => gap.to > gap.from)
  if (!unlockedIndexes.length || !usable.length) return

  const totalFree = usable.reduce((sum, gap) => sum + (gap.to - gap.from), 0)
  const slotCount = unlockedIndexes.length
  // 最大余数法把段数分到各空隙：先取整，再把余数名额给小数部分最大的空隙。
  const exact = usable.map((gap) => (slotCount * (gap.to - gap.from)) / totalFree)
  const counts = exact.map((value) => Math.floor(value))
  let leftover = slotCount - counts.reduce((sum, value) => sum + value, 0)
  const order = exact.map((_, index) => index).sort((a, b) => exact[b] - counts[b] - (exact[a] - counts[a]))
  for (const index of order) {
    if (leftover <= 0) break
    counts[index] += 1
    leftover -= 1
  }

  let slot = 0
  counts.forEach((count, gapIndex) => {
    if (!count || slot >= slotCount) return
    const gap = usable[gapIndex]
    const indexes = unlockedIndexes.slice(slot, slot + count)
    const ws = indexes.map((index) => weightOf(groups[index], index, groups, secPerChar))
    const weightTotal = ws.reduce((sum, value) => sum + value, 0)
    let position = gap.from
    indexes.forEach((groupIndex, k) => {
      const groupId = groups[groupIndex].id
      if (k === indexes.length - 1) {
        result.set(groupId, { groupId, start: round(position), end: gap.to, locked: false })
        return
      }
      const end = round(position + (ws[k] / weightTotal) * (gap.to - gap.from))
      result.set(groupId, { groupId, start: round(position), end, locked: false })
      position = end
    })
    slot += count
  })
}

function round(value: number): number {
  return Math.round(value / TICK) * TICK
}

/**
 * 按当前意群与本次录音时长同步各段时间。
 * - locked 段视为时间锚点，start/end 原样保留（顺序调整后它仍钉在原录音秒数上）；
 * - 未锁定段按意群文字顺序，依次填满锚点之间（以及首尾）的时间空隙，权重为字数 + 后接停顿；
 * - 新增意群没有旧记录，按未锁定参与分配；删除的意群记录直接丢弃。
 */
export function syncSegments(groups: SenseGroup[], duration: number, previous?: GroupTiming[]): GroupTiming[] {
  const max = Math.max(0, duration)
  const prior = new Map((previous ?? []).map((segment) => [segment.groupId, segment]))
  const secPerChar = secondsPerChar(groups, max)

  const result = new Map<string, GroupTiming>()
  const lockedSegments: GroupTiming[] = []
  const unlockedIndexes: number[] = []

  groups.forEach((group, index) => {
    const old = prior.get(group.id)
    if (old?.locked) {
      const start = Math.min(Math.max(0, round(old.start)), max)
      let end = Math.max(start, round(old.end))
      if (max - start >= MIN_SEGMENT) end = Math.min(max, Math.max(end, start + MIN_SEGMENT))
      else end = max
      const segment = { groupId: group.id, start, end, locked: true }
      result.set(group.id, segment)
      lockedSegments.push(segment)
    } else {
      unlockedIndexes.push(index)
    }
  })

  if (unlockedIndexes.length) {
    if (!lockedSegments.length) {
      fillGaps(groups, unlockedIndexes, [{ from: 0, to: max }], secPerChar, result)
    } else {
      // 锚点按录音时间排序（锁定段可能与当前文字顺序交错），空隙是时间轴上未被锚点占住的部分。
      const anchors = [...lockedSegments].sort((a, b) => a.start - b.start || a.end - b.end)
      const gaps: Array<{ from: number; to: number }> = [{ from: 0, to: anchors[0].start }]
      for (let i = 1; i < anchors.length; i++) gaps.push({ from: anchors[i - 1].end, to: anchors[i].start })
      gaps.push({ from: anchors[anchors.length - 1].end, to: max })
      fillGaps(groups, unlockedIndexes, gaps, secPerChar, result)
    }
  }

  // 没有分到空隙的未锁定段（例如锁定段重叠吃光了空间）退化为最小窗口，保证可点可播。
  unlockedIndexes.forEach((index) => {
    const groupId = groups[index].id
    if (!result.has(groupId)) {
      result.set(groupId, { groupId, start: 0, end: round(Math.min(max, MIN_SEGMENT)), locked: false })
    }
  })

  return groups.map((group) => result.get(group.id)!).filter(Boolean)
}

/** 旧版本尝试没有分段记录时，整体估算一次（全部未锁定）。 */
export function normalizeProject(project: PracticeProject): PracticeProject {
  let changed = false
  const attempts: Attempt[] = project.attempts.map((attempt) => {
    if (attempt.segments?.length) {
      const synced = syncSegments(project.groups, attempt.duration, attempt.segments)
      changed = true
      return { ...attempt, segments: synced }
    }
    changed = true
    return { ...attempt, segments: syncSegments(project.groups, attempt.duration, []) }
  })
  return changed ? { ...project, attempts } : project
}

/** 单个意群在本次录音里的估算秒数，找不到时回退到整轮回听范围。 */
export function segmentWindow(attempt: Attempt | undefined, groupId: string): { start: number; end: number } {
  const segment = attempt?.segments?.find((item) => item.groupId === groupId)
  if (segment) {
    if (segment.end > segment.start) return { start: segment.start, end: segment.end }
    const duration = Math.max(attempt?.duration ?? segment.start + MIN_SEGMENT, segment.start + MIN_SEGMENT)
    return { start: segment.start, end: Math.min(duration, segment.start + MIN_SEGMENT) }
  }
  return { start: attempt?.rangeStart ?? 0, end: attempt?.rangeEnd ?? attempt?.duration ?? 0 }
}
