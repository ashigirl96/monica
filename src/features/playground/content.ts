export const emptyContent = "";

export const longContent = `# Heading 1
## Heading 2
### Heading 3

Welcome to the **Milkdown** playground running inside Monica.

Type \`/\` to open the slash menu, or just start writing.

\`\`\`typescript
import { Crepe } from "@milkdown/crepe";

const crepe = new Crepe({ root: "#editor" });
await crepe.create();
\`\`\`

- List item 1
- List item 2
  - Nested item
  - Another nested item
- List item 3

1. Ordered first
2. Ordered second
3. Ordered third

- [ ] Pending task
- [x] Completed task
- [ ] Another task

> "Without music, life would be a mistake." — Friedrich Nietzsche

The equation $E = mc^2$ describes mass-energy equivalence.

$$
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
$$

| Feature      | Default | Notes                |
| ------------ | :-----: | -------------------- |
| CodeMirror   |   on    | syntax highlighting  |
| Table        |   on    | GFM tables           |
| LaTeX        |   on    | math via KaTeX       |
| Image block  |   on    | drag & drop upload   |
`;

export const wikiContent = `# Pink Floyd

**Pink Floyd** are an English [rock](https://en.wikipedia.org/wiki/Rock_music) band formed in London in 1965, distinguished by their extended compositions, sonic experiments, philosophical lyrics, and elaborate live shows.

---

## Members

- **Syd Barrett** (1965–1968) — guitar, lead vocals
- **Roger Waters** (1965–1985) — bass guitar, vocals
- **Nick Mason** (1965–present) — drums
- **Richard Wright** (1965–1979, 1987–2008) — keyboards
- **David Gilmour** (1967–present) — guitar, vocals

## Selected discography

1. *The Piper at the Gates of Dawn* (1967)
2. *The Dark Side of the Moon* (1973)
3. *Wish You Were Here* (1975)
4. *Animals* (1977)
5. *The Wall* (1979)

> "Shine on, you crazy diamond."
`;
