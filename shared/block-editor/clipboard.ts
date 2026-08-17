import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { DOMSerializer, Fragment, Node as PMNode, Slice } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { isEmptyParagraphContainer, nodes, reissueIds, schema } from "./schema";
import { expandedHeadingsDeep, revealPos } from "./folding";
import { containerById, getBlockContext, rangeFromIds, rangePositions } from "./context";
import { deleteRange } from "./commands";
import { blockSelectionKey } from "./selection-state";
import { openLinkMenu } from "./link-menu";
import { buildSyncedContainer, openPasteMenu } from "./paste-menu";

// TODO.md §8.4 / §10.1
export const BLOCKS_MIME = "application/x-monica-blocks+json";

type BlocksPayload = {
  schemaVersion: 1;
  blocks: unknown[];
  /** copy 元ノートの id。paste-and-sync のミラー参照先。旧 payload / desktop copy では欠落。 */
  sourceNoteId?: string;
};

export function serializeBlocksPayload(
  containers: readonly PMNode[],
  sourceNoteId?: string,
): string {
  const payload: BlocksPayload = {
    schemaVersion: 1,
    blocks: containers.map((node) => node.toJSON() as unknown),
    ...(sourceNoteId ? { sourceNoteId } : {}),
  };
  return JSON.stringify(payload);
}

// Rust `to_markdown` と同じ GFM 形にする。この plain text は先読みミス時の代替なので、
// ここだけ表の形が違うと外部へ出したあと貼り戻したときに表に戻らない。
function tableToGfm(table: PMNode): string {
  const lines: string[] = [];
  table.forEach((row, _offset, index) => {
    const cells: string[] = [];
    let header = false;
    row.forEach((cell) => {
      if (cell.attrs.header) header = true;
      // `\` は import 側の escape を食わないよう二重化し、hardBreak は空白へ潰す
      const raw = cell.content.textBetween(0, cell.content.size, undefined, " ");
      cells.push(raw.replace(/\\/g, "\\\\").replace(/\|/g, "\\|"));
    });
    lines.push(`| ${cells.join(" | ")} |`);
    if (index === 0 && header) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
  });
  return lines.join("\n");
}

export function blocksToPlainText(containers: readonly PMNode[]): string {
  const lines: string[] = [];
  const walk = (container: PMNode, depth: number) => {
    const content = container.child(0);
    let text: string;
    if (content.type === nodes.divider) text = "---";
    else if (content.type === nodes.syncedBlock) text = "[synced block]";
    else if (content.type === nodes.table) text = tableToGfm(content);
    else text = content.content.textBetween(0, content.content.size, undefined, "\n");
    lines.push("  ".repeat(depth) + text);
    if (container.childCount > 1) {
      container.child(1).forEach((child) => walk(child, depth + 1));
    }
  };
  for (const container of containers) walk(container, 0);
  return lines.join("\n");
}

// 外部 HTML/plain text に block ID を出さない（TODO.md §10.1）
function stripIds(node: PMNode): PMNode {
  if (node.type === nodes.blockContainer) {
    return node.type.create(
      { ...node.attrs, id: null },
      node.content.content.map(stripIds),
      node.marks,
    );
  }
  if (node.type === nodes.blockGroup) {
    return node.type.create(node.attrs, node.content.content.map(stripIds), node.marks);
  }
  return node;
}

// paste する subtree の正規化: ID 再発行 + heading の畳み解除。BLOCKS_MIME 経路
// （handlePaste）と外部 paste（transformPasted）の両方がここを通る。
function preparePasted(node: PMNode): PMNode {
  return expandedHeadingsDeep(reissueIds(node));
}

function mapSliceNodes(slice: Slice, mapNode: (node: PMNode) => PMNode): Slice {
  const mapFragment = (fragment: Fragment): Fragment =>
    Fragment.from(
      fragment.content.map((node) => {
        const mapped = mapNode(node);
        // container/group は mapNode 内で再帰済み。それ以外は子だけ辿る
        if (mapped === node && node.childCount > 0 && !node.isText) {
          return node.copy(mapFragment(node.content));
        }
        return mapped;
      }),
    );
  return new Slice(mapFragment(slice.content), slice.openStart, slice.openEnd);
}

function blocksToHtml(containers: readonly PMNode[]): string {
  const serializer = DOMSerializer.fromSchema(schema);
  const holder = document.createElement("div");
  holder.append(
    serializer.serializeFragment(Fragment.from(containers.map(stripIds)), { document }),
  );
  return holder.innerHTML;
}

// 元 ID のままの container 群と sourceNoteId を返す。ID 再発行（plain paste）は呼び手の
// 責務 — paste-and-sync は元 blockId を参照先に使うため、ここでは reissue しない。
type ParsedBlocks = { blocks: PMNode[]; sourceNoteId: string | null };

function parseBlocksPayload(raw: string): ParsedBlocks | null {
  let payload: BlocksPayload;
  try {
    payload = JSON.parse(raw) as BlocksPayload;
  } catch {
    return null;
  }
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.blocks)) return null;
  try {
    const blocks = payload.blocks.map((json) => PMNode.fromJSON(schema, json));
    return { blocks, sourceNoteId: payload.sourceNoteId ?? null };
  } catch {
    return null;
  }
}

function selectedContainers(state: EditorState): PMNode[] {
  const selection = blockSelectionKey.getState(state);
  if (!selection || selection.selectedIds.length === 0) return [];
  return selection.selectedIds
    .map((id) => containerById(state.doc, id)?.node)
    .filter((node): node is PMNode => !!node);
}

/** 選択範囲 → to_markdown が食える doc JSON。block 選択は container 群を単一 blockGroup に包む。 */
function docJsonFromContainers(containers: readonly PMNode[]): unknown {
  return {
    type: "doc",
    content: [{ type: "blockGroup", content: containers.map((node) => node.toJSON()) }],
  };
}

/**
 * 現在の選択範囲を to_markdown が食える doc JSON にする。block 選択は container 群を、
 * text 選択は slice の fragment をそのまま doc に載せる（to_markdown はどちらの形にも寛容）。
 */
function selectionJson(state: EditorState): unknown | null {
  const containers = selectedContainers(state);
  if (containers.length > 0) return docJsonFromContainers(containers);
  const sel = state.selection;
  if (!sel.empty) return { type: "doc", content: sel.content().content.toJSON() ?? [] };
  return null;
}

/**
 * 選択範囲を doc JSON + signature に変換する（prefetch と copy で共有する単一経路）。
 * signature が一致することがキャッシュヒットの前提。copy 側は必ず view.state から再計算する
 * （transformCopied で id を潰した slice を使わない）ので prefetch と同一署名になる。
 */
function selectionDocJson(state: EditorState): { json: unknown; signature: string } | null {
  const json = selectionJson(state);
  return json ? { json, signature: JSON.stringify(json) } : null;
}

/** 単一トークンの http(s) URL の paste なら URL を返す（note-mention-menu と共有） */
export function pastedUrl(event: ClipboardEvent): string | null {
  const text = event.clipboardData?.getData("text/plain")?.trim();
  if (!text || /\s/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return text;
}

// 単一 URL のペースト: プレーンリンクを即挿入し、表現の 3 択（URL/Mention/Bookmark）を
// link-menu に委ねる。選択テキストがあれば Notion 同様 link mark を付けるだけ。
function handleUrlPaste(view: EditorView, event: ClipboardEvent): boolean {
  const url = pastedUrl(event);
  if (!url) return false;
  const { state } = view;
  const sel = state.selection;
  const ctx = getBlockContext(sel.$from);
  if (!ctx || ctx.contentNode.type === nodes.codeBlock) return false;
  const linkMark = schema.marks.link.create({ href: url });
  if (!sel.empty) {
    if (!(sel instanceof TextSelection) || sel.$from.parent !== sel.$to.parent) return false;
    view.dispatch(state.tr.addMark(sel.from, sel.to, linkMark));
    return true;
  }
  const from = sel.from;
  const tr = state.tr.replaceWith(from, from, schema.text(url, [linkMark]));
  tr.setSelection(TextSelection.create(tr.doc, from + url.length));
  openLinkMenu(tr, from, url);
  view.dispatch(tr.scrollIntoView());
  return true;
}

function writeBlocksToClipboard(
  event: ClipboardEvent,
  containers: readonly PMNode[],
  sourceNoteId?: string,
  // 先読み markdown がヒットしていれば text/plain に載せる（ミス時はインデント plain text に縮退）。
  // BLOCKS_MIME / html は常に同期で共存させ、paste-and-sync 経路を壊さない。
  markdownPlain?: string,
): void {
  if (!event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData(BLOCKS_MIME, serializeBlocksPayload(containers, sourceNoteId));
  event.clipboardData.setData("text/html", blocksToHtml(containers));
  event.clipboardData.setData("text/plain", markdownPlain ?? blocksToPlainText(containers));
}

/** 選択範囲の doc JSON を markdown へ投影する（Rust `to_markdown` への口）。失敗しない前提。 */
export type RenderMarkdown = (docJson: unknown) => Promise<string>;

/** markdown text を doc JSON へ解釈する（Rust `from_markdown` への口）。 */
export type ParseMarkdown = (markdown: string) => Promise<unknown>;

export type ClipboardOptions = {
  /** copy 時に payload へ載せる現在ノートの id（paste-and-sync のミラー参照元）。 */
  sourceNoteId?: string;
  /** paste 時に「Paste and sync」を提示するか（= resolveBlock が提供されているか）。 */
  syncPasteEnabled?: boolean;
  /** 選択範囲を markdown へ投影する。未指定なら markdown コピーは無効（plain text 縮退）。 */
  renderMarkdown?: RenderMarkdown;
  /** plain text paste を markdown として取り込む。未指定なら素のテキスト挿入に縮退。 */
  parseMarkdown?: ParseMarkdown;
};

/**
 * paste の適用位置。`from`〜`to` が非空ならそこを置換し、`blockIds` は paste 時の block 選択。
 * async な markdown paste では paste 時のこの値を保持して適用するため、選択を直接見ない。
 */
type PasteTarget = { from: number; to: number; blockIds: readonly string[] };

function pasteTargetOf(state: EditorState): PasteTarget {
  return {
    from: state.selection.from,
    to: state.selection.to,
    blockIds: blockSelectionKey.getState(state)?.selectedIds ?? [],
  };
}

/** tr の選択を target の範囲に戻す。位置は doc 内へ丸める（stale な保持位置の防衛）。 */
function selectTarget(tr: Transaction, target: PasteTarget): void {
  const limit = tr.doc.content.size;
  const from = Math.min(Math.max(target.from, 0), limit);
  const to = Math.min(Math.max(target.to, from), limit);
  tr.setSelection(TextSelection.between(tr.doc.resolve(from), tr.doc.resolve(to)));
}

/**
 * paste した blockContainer 列の挿入 transaction を作る。block 選択があればその直後、
 * なければ空 paragraph の置き換えかカーソル block の直後。start より前は触らないので、
 * paste-menu のライブプレビュー（replaceWith）の安定アンカーになる。
 */
function insertBlocksTr(
  state: EditorState,
  blocks: readonly PMNode[],
  target: PasteTarget,
): { tr: Transaction; start: number } | null {
  const tr = state.tr;
  let start: number;
  if (target.blockIds.length > 0) {
    const range = rangeFromIds(state, target.blockIds);
    if (!range) return null;
    start = rangePositions(range).end;
    tr.insert(start, [...blocks]);
  } else {
    // 非空の text 選択は通常の paste と同じく置換対象。残すと選択されたテキストが
    // 消えないまま block が後ろに増える。
    selectTarget(tr, target);
    if (!tr.selection.empty) tr.deleteSelection();
    const ctx = getBlockContext(tr.selection.$from);
    if (!ctx) return null;
    // 空 paragraph（子なし）の上なら置き換え、それ以外は直後に挿入
    if (isEmptyParagraphContainer(ctx.containerNode)) {
      start = ctx.containerPos;
      tr.replaceWith(start, start + ctx.containerNode.nodeSize, [...blocks]);
    } else {
      start = ctx.containerPos + ctx.containerNode.nodeSize;
      tr.insert(start, [...blocks]);
    }
  }
  // 貼り先が collapsed heading の直後（= その heading が隠す範囲）だと、貼った
  // 内容が不可視のままになる。preparePasted が開くのは貼る側の heading だけ
  // なので、貼り先を隠している折りたたみはここで開く。
  revealPos(tr, start);
  return { tr, start };
}

/** parseMarkdown が返した doc JSON から blockContainer 列を取り出す（形が違えば null）。 */
export function containersFromDocJson(docJson: unknown): PMNode[] | null {
  try {
    const doc = PMNode.fromJSON(schema, docJson);
    if (doc.type !== nodes.doc || doc.childCount !== 1) return null;
    const containers: PMNode[] = [];
    doc.child(0).forEach((container) => containers.push(container));
    // fromJSON は content 制約を検証しないので、挿入前にここで弾く
    for (const container of containers) container.check();
    return containers;
  } catch {
    return null;
  }
}

function insertPlainText(view: EditorView, text: string, target: PasteTarget): void {
  const tr = view.state.tr;
  selectTarget(tr, target);
  view.dispatch(tr.insertText(text).scrollIntoView());
}

// parse 済み markdown の挿入。単一の paragraph（子なし）だけは block を増やさず
// カーソル位置へ inline 挿入する（文中への語句 paste が block を割らないように）。
function applyParsedMarkdown(
  view: EditorView,
  docJson: unknown,
  rawText: string,
  target: PasteTarget,
): void {
  const containers = containersFromDocJson(docJson);
  if (!containers) return insertPlainText(view, rawText, target);
  // markdown として空（空白のみ・改行のみ）でも paste は落とさず素のテキストで入れる
  if (containers.length === 0) return insertPlainText(view, rawText, target);
  const blocks = containers.map(preparePasted);
  const only = blocks.length === 1 ? blocks[0] : undefined;
  // block 選択中は inline 挿入だと選択範囲の中へ潜り込む。block 経路で選択の後ろへ入れる
  if (
    target.blockIds.length === 0 &&
    only &&
    only.childCount === 1 &&
    only.child(0).type === nodes.paragraph
  ) {
    const tr = view.state.tr;
    selectTarget(tr, target);
    const inline = new Slice(only.child(0).content, 0, 0);
    view.dispatch(tr.replaceSelection(inline).scrollIntoView());
    return;
  }
  const inserted = insertBlocksTr(view.state, blocks, target);
  if (!inserted) return insertPlainText(view, rawText, target);
  // 待機中の paste の貼り先を、今入れた最後の block の直後へ寄せる。位置の mapping だけでは
  // 貼り先 block が変わらないため、後発の paste が今回の挿入より前へ潜り込む。
  // blocks は非空（上の early return）かつ preparePasted → reissueIds 済みなので id は必ずある。
  const anchor: ClipboardMeta = {
    type: "anchor",
    afterBlockId: blocks[blocks.length - 1].attrs.id as string,
  };
  view.dispatch(inserted.tr.setMeta(clipboardKey, anchor).scrollIntoView());
}

/** async parse を待っている paste。id ごとに適用位置を plugin state 側で mapping 追従させる。 */
let nextPasteId = 0;

/**
 * view ごとの適用キュー。応答順に適用すると、変換の速い後発 paste が先に着地して
 * 貼り順が入れ替わる（先発の貼り先はその挿入の後ろへ mapping される）。変換要求自体は
 * 待たずに投げ、挿入だけを paste を握った順に直列化する。
 */
const pasteChains = new WeakMap<EditorView, Promise<void>>();

// plain text paste の markdown 取り込み。text/html を持つ rich paste は ProseMirror の
// parseDOM に任せ、text/plain のみのときだけ Rust `from_markdown` へ回す。
// 変換は async（handlePaste は同期）なので、先に true を返して paste を握る。応答を
// 待つ間にユーザーが入力・クリックしても貼り先がずれないよう、paste 時の位置を
// plugin state に預け、mapping で追従させた位置に対して挿入する。連続 paste は応答順に
// 依らず握った順で着地させる（pasteChains）。失敗時は素のテキスト挿入に縮退する。
function handleMarkdownPaste(
  view: EditorView,
  event: ClipboardEvent,
  parseMarkdown: ParseMarkdown | undefined,
): boolean {
  if (!parseMarkdown || !event.clipboardData) return false;
  if (event.clipboardData.getData("text/html")) return false;
  const text = event.clipboardData.getData("text/plain");
  if (!text) return false;
  const ctx = getBlockContext(view.state.selection.$from);
  // codeBlock 内は markdown 解釈せず素のテキストのまま（default 挿入）
  if (!ctx || ctx.contentNode.type === nodes.codeBlock) return false;
  const id = nextPasteId++;
  const hold: ClipboardMeta = { type: "hold", id, target: pasteTargetOf(view.state) };
  view.dispatch(view.state.tr.setMeta(clipboardKey, hold).setMeta("addToHistory", false));
  const resume = (apply: (target: PasteTarget) => void) => {
    if (view.isDestroyed) return;
    // plugin state が失われている場合（state 差し替え等）だけ現在の選択に落とす
    const target = clipboardKey.getState(view.state)?.pending.get(id) ?? pasteTargetOf(view.state);
    apply(target);
    const release: ClipboardMeta = { type: "release", id };
    view.dispatch(view.state.tr.setMeta(clipboardKey, release).setMeta("addToHistory", false));
  };
  const applier = parseMarkdown(text).then(
    (docJson) => (target: PasteTarget) => applyParsedMarkdown(view, docJson, text, target),
    () => (target: PasteTarget) => insertPlainText(view, text, target),
  );
  const prev = pasteChains.get(view) ?? Promise.resolve();
  // 1 つの適用が投げても後続の paste を落とさない（キューは常に決着した promise を持つ）
  pasteChains.set(
    view,
    prev
      .then(() => applier)
      .then(resume)
      .catch(() => {}),
  );
  return true;
}

/** async parse 中の paste の適用位置。plugin state で後続編集の mapping に追従させる。 */
type ClipboardState = { pending: ReadonlyMap<number, PasteTarget> };

type ClipboardMeta =
  | { type: "hold"; id: number; target: PasteTarget }
  | { type: "release"; id: number }
  /** 待機中の paste の貼り先を、この block の直後へ付け替える。 */
  | { type: "anchor"; afterBlockId: string };

const clipboardKey = new PluginKey<ClipboardState>("journalClipboard");

const NO_PENDING_PASTE: ClipboardState = { pending: new Map() };

/** 選択が落ち着いてから先読み POST するまでの猶予。 */
const CLIPBOARD_PREFETCH_DEBOUNCE_MS = 150;
/** 先読み markdown キャッシュの上限（現在選択分だけ効けば十分なので小さくてよい）。 */
const MARKDOWN_CACHE_MAX = 16;

export function clipboardPlugin(options: ClipboardOptions = {}): Plugin {
  const { renderMarkdown } = options;

  // 非同期 clipboard の制約回避: 選択が変わるたびに markdown を先読みしておき、copy/cut の同期
  // ハンドラでは同期にキャッシュ参照するだけにする。ヒットしなければ従来の plain text に縮退。
  const cache = new Map<string, string>();
  const inflight = new Set<string>();

  const remember = (signature: string, markdown: string) => {
    cache.set(signature, markdown);
    // 1 回で 1 件しか増えないので上限超過は高々 1 件。最古（挿入順先頭）を落とす。
    if (cache.size > MARKDOWN_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  const prefetch = (signature: string, json: unknown) => {
    if (!renderMarkdown || cache.has(signature) || inflight.has(signature)) return;
    inflight.add(signature);
    renderMarkdown(json)
      .then((markdown) => remember(signature, markdown))
      .catch(() => {})
      .finally(() => inflight.delete(signature));
  };

  // copy 側は必ず view.state から署名を引き直す（transformCopied で id を潰した slice ではなく）。
  const lookupMarkdown = (state: EditorState): string | undefined => {
    const selected = selectionDocJson(state);
    return selected ? cache.get(selected.signature) : undefined;
  };

  return new Plugin<ClipboardState>({
    key: clipboardKey,
    state: {
      init: () => NO_PENDING_PASTE,
      apply(tr, value) {
        const meta = tr.getMeta(clipboardKey) as ClipboardMeta | undefined;
        if (!meta && (!tr.docChanged || value.pending.size === 0)) return value;
        const pending = new Map(value.pending);
        if (tr.docChanged) {
          for (const [id, target] of pending) {
            pending.set(id, {
              ...target,
              from: tr.mapping.map(target.from),
              to: tr.mapping.map(target.to),
            });
          }
        }
        if (meta?.type === "anchor") {
          for (const [id, target] of pending) {
            // 非空の text 選択は置換対象なので付け替えない（block 経路にすると選択が残る）
            if (target.from !== target.to) continue;
            pending.set(id, { ...target, blockIds: [meta.afterBlockId] });
          }
        }
        if (meta?.type === "hold") pending.set(meta.id, meta.target);
        if (meta?.type === "release") pending.delete(meta.id);
        return { pending };
      },
    },
    view: renderMarkdown
      ? (editorView) => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          // 選択が落ち着いてから 1 回だけ選択を直列化して先読みする（毎トランザクションで
          // O(選択サイズ) の JSON.stringify を走らせない）。prefetch が cache/inflight で二重 POST を防ぐ。
          const settle = () => {
            timer = null;
            const selected = selectionDocJson(editorView.state);
            if (selected) prefetch(selected.signature, selected.json);
          };
          return {
            update(view, prevState) {
              // doc・text 選択・block 選択（blockSelectionKey は変更時のみ新参照）のいずれかが
              // 変わったときだけタイマーを張り直す。すべて O(1) の参照/位置比較。
              const changed =
                view.state.doc !== prevState.doc ||
                !view.state.selection.eq(prevState.selection) ||
                blockSelectionKey.getState(view.state) !== blockSelectionKey.getState(prevState);
              if (!changed) return;
              if (timer) clearTimeout(timer);
              timer = setTimeout(settle, CLIPBOARD_PREFETCH_DEBOUNCE_MS);
            },
            destroy() {
              if (timer) clearTimeout(timer);
            },
          };
        }
      : undefined,
    props: {
      // text mode copy は ProseMirror 標準に任せつつ、外部へ出る HTML から ID を剥がす
      transformCopied: (slice) => mapSliceNodes(slice, stripIds),
      // 外部・copy 由来 paste は ID 再発行（重複 ID は normalizer の防衛もある）
      transformPasted: (slice) => mapSliceNodes(slice, preparePasted),
      // text 選択の text/plain を markdown に差し替える（ヒット時のみ。ミス時は ProseMirror 標準と
      // 同じ textBetween に縮退）。block 選択は copy ハンドラが preventDefault するのでここは通らない。
      ...(renderMarkdown
        ? {
            clipboardTextSerializer: (slice: Slice, view: EditorView) =>
              lookupMarkdown(view.state) ??
              slice.content.textBetween(0, slice.content.size, "\n\n"),
          }
        : {}),

      handleDOMEvents: {
        copy(view, event) {
          const containers = selectedContainers(view.state);
          if (containers.length === 0) return false;
          writeBlocksToClipboard(
            event,
            containers,
            options.sourceNoteId,
            lookupMarkdown(view.state),
          );
          return true;
        },
        cut(view, event) {
          const containers = selectedContainers(view.state);
          if (containers.length === 0) return false;
          // cut は元ブロックを削除するので sourceNoteId を載せない。載せると paste-and-sync
          // が「消えたブロック」を指す dangling ミラーになる（cut は move であって参照元にならない）。
          writeBlocksToClipboard(event, containers, undefined, lookupMarkdown(view.state));
          const selection = blockSelectionKey.getState(view.state);
          const range = selection ? rangeFromIds(view.state, selection.selectedIds) : null;
          if (range) view.dispatch(deleteRange(view.state, range));
          return true;
        },
      },

      handlePaste(view, event) {
        const raw = event.clipboardData?.getData(BLOCKS_MIME);
        if (!raw) {
          if (handleUrlPaste(view, event)) return true;
          return handleMarkdownPaste(view, event, options.parseMarkdown);
        }
        const parsed = parseBlocksPayload(raw);
        if (!parsed || parsed.blocks.length === 0) return false;
        const { blocks: originals, sourceNoteId } = parsed;
        // plain paste は常に ID 再発行（重複 ID は normalizer の防衛もある）。
        // originals は synced mirror が元 ID で参照するので触らない。
        const plain = originals.map(preparePasted);

        const inserted = insertBlocksTr(view.state, plain, pasteTargetOf(view.state));
        if (!inserted) return false;
        const { tr, start } = inserted;

        // paste-and-sync が可能なら「Paste as」メニューを相乗りさせる。plugin 未登録
        // （resolveBlock 不在）や旧 payload（sourceNoteId 欠落）なら plain のまま。
        if (
          options.syncPasteEnabled &&
          sourceNoteId &&
          originals.every((container) => container.attrs.id !== null)
        ) {
          openPasteMenu(tr, {
            start,
            plain,
            synced: [buildSyncedContainer(originals, sourceNoteId)],
          });
        }
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    },
  });
}
