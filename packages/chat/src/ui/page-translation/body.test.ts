import { expect, test } from 'bun:test'

import { parseHTML } from 'linkedom'

import { bodyBlocks, isPageChrome } from './body.ts'

const LONG = 'The animals that live in tide pools survive heat, rain and the pounding of waves. '

function page(body: string, title = 'Tide pools of the coast') {
  return parseHTML(`<html><head><title>${title}</title></head><body>${body}</body></html>`).document
}

const texts = (document: Document) =>
  bodyBlocks(document, 'https://coast.example/a').map((b) => b.text)

test('the blocks are the title, headings, paragraphs, list items and cells of the main text, not the navigation, the sidebar or the footer', () => {
  const document = page(`
    <header><nav><a href="/">Home of the coast</a> <a href="/topics">Topics</a></nav></header>
    <main><article>
      <h1>Tide pools of the coast</h1>
      <p>${LONG.repeat(6)}</p>
      <h2>Where they form</h2>
      <p>Pools form in <a href="/rock">hollows of rock</a> at <b>low tide</b>. ${LONG.repeat(3)}</p>
      <ul><li>Sea stars live there and eat mussels.</li></ul>
      <table><tr><td>Anemones close when the tide goes out.</td></tr></table>
    </article></main>
    <aside><p>Related: the best beaches of the year</p></aside>
    <footer><p>Copyright the coast society, all rights reserved</p></footer>`)

  expect(texts(document)).toEqual([
    'Tide pools of the coast',
    LONG.repeat(6).trim(),
    'Where they form',
    `Pools form in <g0>hollows of rock</g0> at <g1>low tide</g1>. ${LONG.repeat(3).trim()}`,
    'Sea stars live there and eat mussels.',
    'Anemones close when the tide goes out.',
  ])
})

test('the summary at the top of an article is main text, though its class reads as front matter', () => {
  const document = page(`
    <main><article>
      <div class="frontmatter"><p class="abstract">A short summary of why tide pools matter to the coast.</p></div>
      <p>${LONG.repeat(6)}</p>
    </article></main>`)

  expect(texts(document)[0]).toBe('A short summary of why tide pools matter to the coast.')
})

test('code blocks, text without two Latin letters in a row, and empty items are no blocks', () => {
  const document = page(`
    <main><article>
      <p>${LONG.repeat(6)}</p>
      <pre><code>const pools = tide.filter(Boolean)</code></pre>
      <p>潮だまりの生き物は 42 種いる。</p>
      <ul><li> </li></ul>
    </article></main>`)

  expect(texts(document)).toEqual([LONG.repeat(6).trim()])
})

test('the marks put on the page to find the main text are taken off again', () => {
  const document = page(`<main><article><p>${LONG.repeat(6)}</p></article></main>`)
  const before = document.body.innerHTML

  bodyBlocks(document, 'https://coast.example/a')

  expect(document.body.innerHTML).toBe(before)
})

test('an article that embeds a post as its own article and a widget with its own main is still the main text', () => {
  const labels = Array.from({ length: 30 }, (_, i) => `<p>agent.step</p> <p>${i}ms</p>`)
  const document = page(`
    <div><article>
      <p>${LONG.repeat(6)}</p>
      <figure><article><p>Sea stars before and after the storm</p></article></figure>
      <section><main>${labels.join(' ')}</main></section>
      <p>Pools refill when the tide comes back in.</p>
    </article></div>
    <div><p>${LONG.repeat(30)}</p></div>`)

  const blocks = texts(document)
  expect([blocks[0], blocks.at(-1)]).toEqual([
    LONG.repeat(6).trim(),
    'Pools refill when the tide comes back in.',
  ])
})

test('a menu that Defuddle keeps in the main text is still no block', () => {
  const document = page(`
    <main><article>
      <p>${LONG.repeat(6)}</p>
      <div role="menu"><p>Share this article about the sea stars of the northern coast</p></div>
    </article></main>`)

  expect(texts(document)).toEqual([LONG.repeat(6).trim()])
})

// 狭い窓の GitHub のように Defuddle が header のメニューまで本文に残すページでも、ページの骨組みの中は訳さない。
test('the header, footer and side bars of the page and anything in a navigation are page chrome, while the header of an article is not', () => {
  const document = page(`
    <header><ul><li id="menu">Changelog</li></ul></header>
    <main>
      <article><header><p id="byline">Written by the society</p></header><p id="body">Pools</p></article>
      <div role="navigation"><p id="next">Next article</p></div>
      <nav><p id="nav">Topics</p></nav>
    </main>
    <aside><p id="aside">Related reading</p></aside>
    <div role="banner"><p id="banner">Sign in</p></div>
    <footer><p id="footer">Copyright</p></footer>`)
  const chrome = (id: string) => isPageChrome(document.getElementById(id)!)

  expect(['menu', 'next', 'nav', 'aside', 'banner', 'footer'].map(chrome)).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
  ])
  expect(['byline', 'body'].map(chrome)).toEqual([false, false])
})
