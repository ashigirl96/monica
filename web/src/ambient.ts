/**
 * 面の下に敷く背景写真のプリセット。light / dark とは直交する軸で、色は変えずに
 * 一枚の写真だけを差し替える。値は :root の CSS 変数として流し込み、notes.css の
 * .notes-screen::before が受け取る。
 *
 * blur と opacity を写真ごとに持つのは、必要なぼかし量が被写体の空間周波数で決まるため。
 * 滑らかなグラデーションは薄くぼかせば足りるが、枝や提灯のような輪郭は形が判別できる
 * 手前まで潰さないと本文の裏でちらつく。
 * light の opacity が低いのは、白い紙に黒文字を載せる以上 --paper の alpha を厚く
 * 残す必要があり、その減衰ぶんを差し引いて透ける量を dark と揃えているため。
 */
export const AMBIENTS = {
  universe: {
    label: "Universe",
    image: "/ambient-universe.jpg",
    blur: "2px",
    opacity: { dark: 0.85, light: 0.6 },
  },
  sakura: {
    label: "Sakura",
    image: "/ambient-sakura.jpg",
    blur: "10px",
    opacity: { dark: 0.8, light: 0.5 },
  },
  village: {
    label: "Village",
    image: "/ambient-village.jpg",
    blur: "10px",
    opacity: { dark: 0.8, light: 0.5 },
  },
  fireworks: {
    label: "Fireworks",
    image: "/ambient-fireworks.jpg",
    blur: "4px",
    opacity: { dark: 0.85, light: 0.6 },
  },
  shrine: {
    label: "Shrine",
    image: "/ambient-shrine.jpg",
    blur: "10px",
    opacity: { dark: 0.7, light: 0.5 },
  },
} as const;

export type AmbientName = keyof typeof AMBIENTS;

export const AMBIENT_NAMES = Object.keys(AMBIENTS) as AmbientName[];

const DEFAULT_AMBIENT: AmbientName = "universe";
const STORAGE_KEY = "monica-ambient";

// hasOwn で見るのは prototype 継承分を弾くため。`in` だと "constructor" や "__proto__" が
// 通り、apply() が opacity を持たない値を触って main.tsx の render 前に throw する
// （= 不正値が localStorage に残ったまま画面が白く固まる）
function isAmbientName(raw: string | null): raw is AmbientName {
  return raw !== null && Object.hasOwn(AMBIENTS, raw);
}

export function ambientPref(): AmbientName {
  const raw = localStorage.getItem(STORAGE_KEY);
  return isAmbientName(raw) ? raw : DEFAULT_AMBIENT;
}

function apply(name: AmbientName) {
  const ambient = AMBIENTS[name];
  const style = document.documentElement.style;
  style.setProperty("--ambient", `url("${ambient.image}")`);
  style.setProperty("--ambient-blur", ambient.blur);
  // 採用するのは light / dark どちらか — その判定は notes.css のカスケードに任せる。
  // ここでテーマを読むと ambient と theme が相互に再実行を要求し合う関係になる
  style.setProperty("--ambient-opacity-dark", String(ambient.opacity.dark));
  style.setProperty("--ambient-opacity-light", String(ambient.opacity.light));
}

export function setAmbientPref(name: AmbientName) {
  localStorage.setItem(STORAGE_KEY, name);
  apply(name);
}

export function initAmbient() {
  apply(ambientPref());
}
