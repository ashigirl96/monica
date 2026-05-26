import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { Slice } from "@milkdown/kit/prose/model";
import { Selection } from "@milkdown/kit/prose/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Compartment, createCmState, darkExtension } from "./cm-setup";
import { emptyContent, longContent, wikiContent } from "./content";
import "@milkdown/crepe/theme/common/style.css";
import "./styles.css";

type SampleKey = "empty" | "long" | "wiki";

const SAMPLES: Record<SampleKey, { label: string; value: string }> = {
  empty: { label: "Empty", value: emptyContent },
  long: { label: "Full sample", value: longContent },
  wiki: { label: "Wiki", value: wikiContent },
};

interface FeatureFlags {
  codeMirror: boolean;
  topBar: boolean;
  table: boolean;
  imageBlock: boolean;
  latex: boolean;
}

const DEFAULT_FEATURES: FeatureFlags = {
  codeMirror: true,
  topBar: false,
  table: true,
  imageBlock: true,
  latex: true,
};

type FocusOwner = "crepe" | "cm" | null;

export default function MilkdownPlayground() {
  const [sample, setSample] = useState<SampleKey>("long");
  const [readonly, setReadonly] = useState(false);
  const [dark, setDark] = useState(false);
  const [features, setFeatures] = useState<FeatureFlags>(DEFAULT_FEATURES);

  const initialValue = useMemo(() => SAMPLES[sample].value, [sample]);

  return (
    <div className={cn("playground-shell", dark && "dark")}>
      <aside className="playground-sidebar">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Milkdown Playground</h1>
          <p className="mt-1 text-xs opacity-60">Powered by @milkdown/crepe</p>
        </div>

        <ControlSection title="Sample">
          {(Object.keys(SAMPLES) as SampleKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSample(key)}
              className={cn(
                "rounded-md border px-3 py-1.5 text-left text-sm transition-colors",
                sample === key
                  ? "border-current bg-current/10"
                  : "border-current/20 hover:bg-current/5",
              )}
            >
              {SAMPLES[key].label}
            </button>
          ))}
        </ControlSection>

        <ControlSection title="Features">
          {(Object.keys(features) as (keyof FeatureFlags)[]).map((key) => (
            <Toggle
              key={key}
              label={key.replace(/([A-Z])/g, " $1").trim()}
              checked={features[key]}
              onChange={(v) => setFeatures((p) => ({ ...p, [key]: v }))}
            />
          ))}
        </ControlSection>

        <ControlSection title="Mode">
          <Toggle label="Readonly" checked={readonly} onChange={setReadonly} />
          <Toggle label="Dark theme" checked={dark} onChange={setDark} />
        </ControlSection>
      </aside>

      <PlaygroundPanes
        initialValue={initialValue}
        features={features}
        readonly={readonly}
        dark={dark}
      />
    </div>
  );
}

function ControlSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wider opacity-60">{title}</h2>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm capitalize">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="h-4 w-4"
      />
      <span>{label}</span>
    </label>
  );
}

interface PanesProps {
  initialValue: string;
  features: FeatureFlags;
  readonly: boolean;
  dark: boolean;
}

function PlaygroundPanes({ initialValue, features, readonly, dark }: PanesProps) {
  const focusRef = useRef<FocusOwner>(null);
  const crepeUpdateRef = useRef<((md: string) => void) | null>(null);
  const cmUpdateRef = useRef<((md: string) => void) | null>(null);
  const latestMdRef = useRef<string>(initialValue);
  const lastSampleRef = useRef<string>(initialValue);

  // Sync the latest-markdown ref synchronously during render when the sample
  // changes, so child useLayoutEffects see the new seed before they remount.
  // Mutating refs during render is safe because there's no derived state.
  if (lastSampleRef.current !== initialValue) {
    lastSampleRef.current = initialValue;
    latestMdRef.current = initialValue;
  }

  const handleCrepeChange = useCallback((md: string) => {
    latestMdRef.current = md;
    if (focusRef.current === "cm") return;
    cmUpdateRef.current?.(md);
  }, []);

  const handleCmChange = useCallback((md: string) => {
    latestMdRef.current = md;
    if (focusRef.current === "crepe") return;
    crepeUpdateRef.current?.(md);
  }, []);

  const handleCrepeFocus = useCallback((focused: boolean) => {
    focusRef.current = focused ? "crepe" : null;
  }, []);

  const handleCmFocus = useCallback((focused: boolean) => {
    focusRef.current = focused ? "cm" : null;
  }, []);

  const registerCrepeUpdater = useCallback((fn: ((md: string) => void) | null) => {
    crepeUpdateRef.current = fn;
  }, []);

  const registerCmUpdater = useCallback((fn: ((md: string) => void) | null) => {
    cmUpdateRef.current = fn;
  }, []);

  return (
    <>
      <section className="playground-pane">
        <CrepePane
          initialValue={initialValue}
          latestMdRef={latestMdRef}
          features={features}
          readonly={readonly}
          onChange={handleCrepeChange}
          onFocus={handleCrepeFocus}
          registerUpdater={registerCrepeUpdater}
        />
      </section>
      <section className="playground-pane cm">
        <CmPane
          initialValue={initialValue}
          latestMdRef={latestMdRef}
          dark={dark}
          onChange={handleCmChange}
          onFocus={handleCmFocus}
          registerUpdater={registerCmUpdater}
        />
      </section>
    </>
  );
}

interface CrepePaneProps {
  initialValue: string;
  latestMdRef: React.MutableRefObject<string>;
  features: FeatureFlags;
  readonly: boolean;
  onChange: (md: string) => void;
  onFocus: (focused: boolean) => void;
  registerUpdater: (fn: ((md: string) => void) | null) => void;
}

function CrepePane({
  initialValue,
  latestMdRef,
  features,
  readonly,
  onChange,
  onFocus,
  registerUpdater,
}: CrepePaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const loadingRef = useRef(false);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Block re-entry during async create() — protects against StrictMode's
    // double mount/cleanup, which would otherwise race two Crepe instances
    // through the same host DOM and leave the block plugin's rAF init in a
    // broken state (drag handle ends up without draggable=true).
    if (loadingRef.current) return;
    loadingRef.current = true;

    const crepe = new Crepe({
      root: host,
      defaultValue: latestMdRef.current,
      features: {
        [Crepe.Feature.CodeMirror]: features.codeMirror,
        [Crepe.Feature.TopBar]: features.topBar,
        [Crepe.Feature.Table]: features.table,
        [Crepe.Feature.ImageBlock]: features.imageBlock,
        [Crepe.Feature.Latex]: features.latex,
      },
    });

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, md) => onChange(md));
      listener.focus(() => onFocus(true));
      listener.blur(() => onFocus(false));
    });
    crepe.setReadonly(readonly);

    registerUpdater((md) => {
      const ready = crepeRef.current;
      if (!ready) return;
      if (ready.getMarkdown() === md) return;
      ready.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const doc = parser(md);
        if (!doc) return;
        const tr = view.state.tr.replace(
          0,
          view.state.doc.content.size,
          new Slice(doc.content, 0, 0),
        );
        const safeFrom = Math.min(view.state.selection.from, doc.content.size);
        tr.setSelection(Selection.near(tr.doc.resolve(safeFrom)));
        view.dispatch(tr);
      });
    });

    crepe
      .create()
      .then(() => {
        crepeRef.current = crepe;
        loadingRef.current = false;
      })
      .catch((err: unknown) => {
        loadingRef.current = false;
        console.error("[milkdown] create failed", err);
      });

    return () => {
      if (loadingRef.current) return;
      registerUpdater(null);
      const ready = crepeRef.current;
      crepeRef.current = null;
      if (ready) void ready.destroy();
    };
  }, [initialValue, latestMdRef, features, readonly, onChange, onFocus, registerUpdater]);

  return <div ref={hostRef} className="crepe-host" />;
}

interface CmPaneProps {
  initialValue: string;
  latestMdRef: React.MutableRefObject<string>;
  dark: boolean;
  onChange: (md: string) => void;
  onFocus: (focused: boolean) => void;
  registerUpdater: (fn: ((md: string) => void) | null) => void;
}

function CmPane({
  initialValue,
  latestMdRef,
  dark,
  onChange,
  onFocus,
  registerUpdater,
}: CmPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef<Compartment | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const themeCompartment = new Compartment();
    themeCompartmentRef.current = themeCompartment;
    const view = new EditorView({
      state: createCmState({
        doc: latestMdRef.current,
        dark,
        themeCompartment,
        onChange,
        onFocus,
      }),
      parent: host,
    });
    viewRef.current = view;

    registerUpdater((md) => {
      if (view.state.doc.toString() === md) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: md },
      });
    });

    return () => {
      registerUpdater(null);
      viewRef.current = null;
      themeCompartmentRef.current = null;
      view.destroy();
    };
    // dark is intentionally excluded — the theme is hot-swapped below
    // without re-mounting so the user's CM cursor / scroll / selection
    // are preserved on light/dark toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue, latestMdRef, onChange, onFocus, registerUpdater]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = themeCompartmentRef.current;
    if (!view || !compartment) return;
    view.dispatch({ effects: compartment.reconfigure(darkExtension(dark)) });
  }, [dark]);

  return <div ref={hostRef} className="cm-host" />;
}
