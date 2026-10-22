import { expect, test } from 'claude-code/testing'

import { textRows, treeRows } from './stack'

const box = (props: Record<string, unknown>, ...children: unknown[]) => ({ type: 'Box', props, children })
const text = (s: string, props: Record<string, unknown> = {}) => ({ type: 'Text', props, children: [s] })

test('什麼都沒畫的不佔列：引擎自己的空位、空的 Box、讓路的 null', () => {
  expect(treeRows({ type: 'engine', ref: 0 }, 95)).toBe(0)
  expect(treeRows(box({}), 95)).toBe(0)
  expect(treeRows(box({ flexDirection: 'column' }, null, false, box({})), 95)).toBe(0)
  expect(treeRows(null, 95)).toBe(0)
  // 外層照約定疊了引擎的節點也一樣：只算看得到的那幾列
  expect(treeRows(box({ flexDirection: 'column' }, text('提示'), { type: 'engine', ref: 1 }), 95)).toBe(1)
})

test('字照欄寬折行，全形算兩欄；截斷的不折', () => {
  expect(textRows('a'.repeat(95), 95)).toBe(1)
  expect(textRows('a'.repeat(96), 95)).toBe(2)
  expect(textRows('中'.repeat(48), 95)).toBe(2)
  expect(textRows('一\n二\n三', 95)).toBe(3)
  expect(treeRows(text('a'.repeat(200), { wrap: 'truncate' }), 95)).toBe(1)
  expect(treeRows(text('a'.repeat(200)), 95)).toBe(3)
})

test('直排相加（含間距）、橫排取最高；框線上下各一列，內距照算', () => {
  const notice = box({ flexDirection: 'column', gap: 1 }, text('第一行'), text('第二行'), { type: 'Button', props: { key: 'ok', label: '知道了' } })
  expect(treeRows(notice, 95)).toBe(5)
  expect(treeRows(box({ flexDirection: 'row', gap: 1 }, text('a'), box({ flexDirection: 'column' }, text('b'), text('c'))), 95)).toBe(2)
  expect(treeRows(box({ borderStyle: 'round', paddingY: 1 }, text('a')), 95)).toBe(5)
  // 框線與左右內距吃掉欄寬：95 欄的字放進有框、左右各留 2 欄的 Box 要折成兩行
  expect(treeRows(box({ borderStyle: 'round', paddingX: 2 }, text('a'.repeat(95))), 95)).toBe(4)
  expect(treeRows(box({ display: 'none' }, text('a')), 95)).toBe(0)
})

test('疊在別的元素上的不另外佔列；圖照自己寫的高度換算（一列 19px）', () => {
  const card = box(
    { flexDirection: 'column' },
    { type: 'Svg', props: { source: '<svg xmlns="http://www.w3.org/2000/svg" width="718" height="57"></svg>', alt: '卡' } },
    box({ position: 'absolute', top: 1, right: 1 }, { type: 'Button', props: { key: 'run', label: '▶' } }),
  )
  expect(treeRows(card, 95)).toBe(3)
  expect(treeRows({ type: 'Svg', props: { source: '<svg/>', alt: '', height: 40 } }, 95)).toBe(3)
})
