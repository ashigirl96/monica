// schema の bullet と numbered は editor が書いた div しか読まないので、外の HTML の ul・ol は
// 段落に崩れる。読む前に、editor が書くのと同じ container と group の入れ子に書き換える。

const BLOCK_KIND = { UL: 'bullet', OL: 'numbered' } as const

function isList(node: Node): node is HTMLUListElement | HTMLOListElement {
  return node instanceof Element && (node.tagName === 'UL' || node.tagName === 'OL')
}

// 太字などを ul・ol・li・p の style で書く HTML があるので、外す要素の style は span に移して mark に読ませる。
function keepStyle(style: string, nodes: Node[], doc: Document): Node[] {
  if (!style) return nodes
  const span = doc.createElement('span')
  span.setAttribute('style', style)
  span.append(...nodes)
  return [span]
}

// CSS の継承と同じく、外の要素の style を内の項目へ渡し、同じ property は内側が勝つ。
const withStyle = (outer: string, el: Element) =>
  [outer, el.getAttribute('style')].filter(Boolean).join(';')

function containersOf(
  list: HTMLUListElement | HTMLOListElement,
  doc: Document,
  inherited = '',
): HTMLElement[] {
  const kind = BLOCK_KIND[list.tagName as keyof typeof BLOCK_KIND]
  const listStyle = withStyle(inherited, list)
  return [...list.children]
    .filter((item) => item.tagName === 'LI')
    .map((item) => {
      const itemStyle = withStyle(listStyle, item)
      const content = doc.createElement('div')
      content.dataset.blockContent = kind
      const children: HTMLElement[] = []
      // childNodes は動かすと縮むので、先に配列に写す。
      for (const child of Array.from(item.childNodes)) {
        if (isList(child)) children.push(...containersOf(child, doc, itemStyle))
        // shortcut: 段落を複数持つ項目は 1 行につなげる。行を分けたいと言われたら兄弟の段落にする。
        else if (child instanceof Element && child.tagName === 'P')
          content.append(
            ...keepStyle(child.getAttribute('style') ?? '', [...child.childNodes], doc),
          )
        else content.append(child)
      }
      content.replaceChildren(...keepStyle(itemStyle, [...content.childNodes], doc))
      const container = doc.createElement('div')
      container.dataset.blockContainer = ''
      container.append(content)
      if (children.length > 0) {
        const group = doc.createElement('div')
        group.dataset.blockGroup = ''
        group.append(...children)
        container.append(group)
      }
      return container
    })
}

/** 外から貼った HTML の ul・ol を、editor の bullet・numbered の block の入れ子に書き換える。 */
export function listsToBlocks(html: string): string {
  if (!/<[ou]l[\s>]/i.test(html)) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const list of doc.body.querySelectorAll('ul, ol')) {
    if (!list.isConnected || list.parentElement?.closest('li')) continue
    list.replaceWith(...containersOf(list as HTMLUListElement | HTMLOListElement, doc))
  }
  return doc.body.innerHTML
}
