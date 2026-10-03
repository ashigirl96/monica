import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
  type Client,
  createClient,
  type Endpoint,
  restartBackend,
  watchBackend,
} from "./backend.ts";

// bun --watch の再起動（約 100ms）で帯がちらつかないよう、不在が続いたときだけ出す。
const ABSENCE_BEFORE_BANNER_MS = 1000;

const BackendContext = createContext<Client | null>(null);

export function useBackend(): Client | null {
  return useContext(BackendContext);
}

export function BackendProvider({ children }: { children: ReactNode }) {
  const [endpoint, setEndpoint] = useState<Endpoint | null>(null);
  const [absent, setAbsent] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const noticeAbsence = () => setTimeout(() => setAbsent(true), ABSENCE_BEFORE_BANNER_MS);
    let timer = noticeAbsence();
    const stop = watchBackend({
      onEndpoint: (next) => {
        clearTimeout(timer);
        setEndpoint(next);
        setAbsent(false);
        if (next) setFailed(false);
        else timer = noticeAbsence();
      },
      onFailed: () => setFailed(true),
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, []);

  const client = useMemo(() => (endpoint ? createClient(endpoint) : null), [endpoint]);

  return (
    <BackendContext value={client}>
      {failed ? (
        <div role="alert" style={bannerStyle}>
          Backend を起動できません{" "}
          <button
            type="button"
            onClick={() => {
              setFailed(false);
              void restartBackend();
            }}
          >
            再試行
          </button>
        </div>
      ) : absent ? (
        <div role="status" style={bannerStyle}>
          Backend に再接続中…
        </div>
      ) : null}
      {children}
    </BackendContext>
  );
}

const bannerStyle = { padding: "4px 12px", background: "#fdf3d8", color: "#3d2f00", fontSize: 13 };
