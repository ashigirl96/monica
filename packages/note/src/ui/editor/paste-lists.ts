// schema の bullet と numbered は editor が書いた div しか読まないので、外の HTML の ul・ol は
// 段落に崩れる。読む前に、editor が書くのと同じ container と group の入れ子に書き換える。

const BLOCK_KIND = { UL: 'bullet', OL: 'numbered' } as const

function isList(node: Node): node is HTMLUListElement | HTMLOListElement {
  return node instanceof Element && (node.tagName === 'UL' || node.tagName === 'OL')
}

// 太字などを p の style で書く HTML があるので、p を外すときは style を span に移して mark に読ませる。
function unwrap(paragraph: Element, doc: Document): Node[] {
  const style = paragraph.getAttribute('style')
  if (!style) return [...paragraph.childNodes]
  const span = doc.createElement('span')
  span.setAttribute('style', style)
  span.append(...paragraph.childNodes)
  return [span]
}

function containersOf(list: HTMLUListElement | HTMLOListElement, doc: Document): HTMLElement[] {
  const kind = BLOCK_KIND[list.tagName as keyof typeof BLOCK_KIND]
  return [...list.children]
    .filter((item) => item.tagName === 'LI')
    .map((item) => {
      const content = doc.createElement('div')
      content.dataset.blockContent = kind
      const children: HTMLElement[] = []
      // childNodes は動かすと縮むので、先に配列に写す。
      for (const child of Array.from(item.childNodes)) {
        if (isList(child)) children.push(...containersOf(child, doc))
        // shortcut: 段落を複数持つ項目は 1 行につなげる。行を分けたいと言われたら兄弟の段落にする。
        else if (child instanceof Element && child.tagName === 'P')
          content.append(...unwrap(child, doc))
        else content.append(child)
      }
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
