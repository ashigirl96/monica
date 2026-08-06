import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { createContainer, nodes, schema } from "./schema";
import { containerById } from "./context";

// テスト専用: doc fixture builder と位置解決 helper。

export function para(text = ""): PMNode {
  return nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}

export function todo(text = "", checked = false): PMNode {
  return nodes.todo.create({ checked }, text ? schema.text(text) : undefined);
}

export function bullet(text = ""): PMNode {
  return nodes.bullet.create(null, text ? schema.text(text) : undefined);
}

export function heading(text: string, level = 1, collapsed = false): PMNode {
  return nodes.heading.create({ level, collapsed }, text ? schema.text(text) : undefined);
}

export function code(text = ""): PMNode {
  return nodes.codeBlock.create(null, text ? schema.text(text) : undefined);
}

export function callout(text = "", collapsed = false): PMNode {
  return nodes.callout.create({ collapsed }, text ? schema.text(text) : undefined);
}

export function toggle(text = "", open = true): PMNode {
  return nodes.toggle.create({ open }, text ? schema.text(text) : undefined);
}

export function tableOf(rows: string[][], headerFirst = false): PMNode {
  return nodes.table.create(
    null,
    rows.map((cells, r) =>
      nodes.tableRow.create(
        null,
        cells.map((text) =>
          nodes.tableCell.create(
            { header: headerFirst && r === 0 },
            text ? schema.text(text) : undefined,
          ),
        ),
      ),
    ),
  );
}

export function block(id: string, content: PMNode, children: PMNode[] = []): PMNode {
  return createContainer(content, children, id);
}

export function docOf(...blocks: PMNode[]): PMNode {
  return nodes.doc.create(null, nodes.blockGroup.create(null, blocks));
}

export function posOf(doc: PMNode, id: string): number {
  const entry = containerById(doc, id);
  if (!entry) throw new Error(`no container ${id}`);
  return entry.pos;
}

/** id の block の blockContent 内 offset を doc position に解決する */
export function contentPos(doc: PMNode, id: string, offset: number | "start" | "end"): number {
  const entry = containerById(doc, id);
  if (!entry) throw new Error(`no container ${id}`);
  const base = entry.pos + 2;
  if (offset === "start") return base;
  if (offset === "end") return base + entry.node.child(0).content.size;
  return base + offset;
}
