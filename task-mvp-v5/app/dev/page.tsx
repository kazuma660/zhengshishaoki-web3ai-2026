"use client";

// =============================================================================
// TaskLog ― Plan E v3（気になること = 消えないメモ / タスク = そこから生やす）
//
// 置き場所：  task-mvp-v5/app/dev/page.tsx   →  http://localhost:3203/dev
//
// ★データの持ち方が本番 page.tsx（users/{uid}.items）と違うので、
//   本番を壊さないよう /dev は users/{uid}.devItems に分けて保存する。
//   初回だけ既存 items から自動で取り込む（notes / tasks に変換）。
//   気に入ったら devItems を items に昇格させて本番へ統合する。
// =============================================================================

import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { auth, db, googleProvider } from "../lib/firebase";
import { createUserWithEmailAndPassword, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, User } from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

// ---- v3 データモデル（同じドキュメントの devItems フィールドに保存） --------
type Sub = { id: string; title: string; subs?: Sub[] };
type Node = {
  id: string;
  type: "note" | "task";
  title: string;
  createdAt: number;
  // note 専用
  subs?: Sub[];
  // task 専用
  step?: string;
  state?: "today" | "tomorrow" | "done" | "missed";
  sourceId?: string | null;   // 生やし元の note.id
  parentTitle?: string | null; // 分解元の見出し
  completedAt?: number;
  missedAt?: number;
};

// 本番の元データ型（移行用に読むだけ）
type LegacyItem = {
  id: string; title: string; createdAt: number;
  isToday?: boolean; isTomorrow?: boolean; parentId?: string;
  completedAt?: number; missedAt?: number; letGoAt?: number; miniStep?: string;
};

const MAX_SUB = 5;
const MAX_DEPTH = 5;
const DELETE_AFTER_DAYS = 365;
const ARCHIVE_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;
function autoMode(): "morning" | "night" {
  const h = new Date().getHours();
  return h >= 6 && h < 18 ? "morning" : "night";
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "id" + Date.now() + Math.random().toString(16).slice(2));
function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isEnterSubmit(e: React.KeyboardEvent): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

function authErrorMessage(code: string): string {
  switch (code) {
    case "auth/invalid-email": return "メールアドレスの形式が正しくないよ。";
    case "auth/user-not-found":
    case "auth/invalid-credential":
    case "auth/wrong-password": return "メールかパスワードが違うみたい。";
    case "auth/email-already-in-use": return "このメールはもう登録済み。「ログイン」を試して。";
    case "auth/weak-password": return "パスワードは6文字以上にしてね。";
    case "auth/operation-not-allowed": return "メール/パスワードがまだ有効化されてない（Firebase側の設定が必要）。";
    case "auth/too-many-requests": return "試しすぎ。少し待ってから再挑戦して。";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request": return "";
    default: return "ログインに失敗した。もう一回試して。";
  }
}

// 気になることの子ツリー操作（再帰・最大5段ネスト）
function addSubUnder(subs: Sub[], parentId: string, child: Sub): Sub[] {
  return subs.map((s) => s.id === parentId
    ? { ...s, subs: [...(s.subs ?? []), child] }
    : (s.subs ? { ...s, subs: addSubUnder(s.subs, parentId, child) } : s));
}
function removeSubById(subs: Sub[], id: string): Sub[] {
  return subs.filter((s) => s.id !== id).map((s) => (s.subs ? { ...s, subs: removeSubById(s.subs, id) } : s));
}
function editSubById(subs: Sub[], id: string, title: string): Sub[] {
  return subs.map((s) => s.id === id ? { ...s, title } : (s.subs ? { ...s, subs: editSubById(s.subs, id, title) } : s));
}
function findSub(subs: Sub[], id: string): Sub | null {
  for (const s of subs) { if (s.id === id) return s; const f = s.subs ? findSub(s.subs, id) : null; if (f) return f; }
  return null;
}

// 既存 items → v3（notes / tasks）への一回限りの変換
function migrateFromLegacy(legacy: LegacyItem[]): Node[] {
  const live = legacy.filter((it) => !it.letGoAt);
  const byId = new Map(live.map((it) => [it.id, it]));
  const isScheduled = (it: LegacyItem) => it.isToday || it.isTomorrow || it.completedAt || it.missedAt;
  const out: Node[] = [];

  // pool（未スケジュール）の親 → note、その pool 子 → subs
  const poolRoots = live.filter((it) => {
    if (isScheduled(it)) return false;
    if (!it.parentId) return true;
    const p = byId.get(it.parentId);
    return !p || isScheduled(p);
  });
  poolRoots.forEach((root) => {
    const subs = live
      .filter((c) => c.parentId === root.id && !isScheduled(c))
      .map((c) => ({ id: c.id, title: c.title }));
    out.push({ id: root.id, type: "note", title: root.title, createdAt: root.createdAt, subs });
  });

  // スケジュール済み → task
  live.filter(isScheduled).forEach((it) => {
    const parent = it.parentId ? byId.get(it.parentId) : undefined;
    const state: Node["state"] = it.completedAt ? "done" : it.missedAt ? "missed" : it.isTomorrow ? "tomorrow" : "today";
    const node: Node = {
      id: it.id, type: "task", title: it.title, createdAt: it.createdAt,
      step: it.miniStep ?? "", state, sourceId: it.parentId ?? null,
      parentTitle: parent ? parent.title : null,
    };
    // Firestore は undefined を拒否するので、値がある時だけ入れる
    if (it.completedAt) node.completedAt = it.completedAt;
    if (it.missedAt) node.missedAt = it.missedAt;
    out.push(node);
  });
  return out;
}

const MORNING = {
  page: "#efe7d8", panel: "#fbf8f1", panel2: "#f4eee1", edge: "#e7dcc8",
  ink: "#2d2823", soft: "#857b6d", faint: "#a99e8c", line: "#e7ddcb",
  accent: "#b3622e", accentBg: "#f3e3d3", sage: "#5e7256", sageBg: "#e8ecdf",
  amber: "#a9821f", amberBg: "#f1e8cf", inputBg: "#ffffff",
};
const NIGHT = {
  page: "#101118", panel: "#1d1f28", panel2: "#191b23", edge: "#2c2f3b",
  ink: "#ece6d9", soft: "#9a948a", faint: "#6f6a62", line: "#2a2d39",
  accent: "#dd9152", accentBg: "#2e2618", sage: "#88a37b", sageBg: "#1f271e",
  amber: "#cda451", amberBg: "#2a2618", inputBg: "#15161e",
};
type Theme = typeof MORNING;
const SERIF = "'Shippori Mincho', serif";
const SANS = "'Zen Kaku Gothic New', sans-serif";

export default function DevPlanE3() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [lastSeen, setLastSeen] = useState<string>("");
  const [hydrated, setHydrated] = useState(false);
  const lastRemoteJsonRef = useRef<string>("");

  const [mode, setMode] = useState<"morning" | "night">("morning");
  const [capture, setCapture] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [childInputs, setChildInputs] = useState<Record<string, string>>({});
  const [focusId, setFocusId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [showReview, setShowReview] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [view, setView] = useState<"capture" | "do">("do");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  const t: Theme = mode === "night" ? NIGHT : MORNING;
  const night = mode === "night";

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }, []);

  async function handleEmailAuth() {
    const em = email.trim();
    if (!em || !password) { setAuthError("メールとパスワードを入れてね。"); return; }
    setAuthBusy(true); setAuthError(null);
    try {
      if (authMode === "signup") await createUserWithEmailAndPassword(auth, em, password);
      else await signInWithEmailAndPassword(auth, em, password);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setAuthError(authErrorMessage(code) || "ログインに失敗した。");
    } finally { setAuthBusy(false); }
  }

  useEffect(() => {
    const id = "tasklog-dev-fonts";
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id; link.rel = "stylesheet";
      link.href = "https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;600;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap";
      document.head.appendChild(link);
    }
  }, []);
  // 朝/夜は時間で自動切替（6:00–18:00=朝）。1分ごとに再判定。
  useEffect(() => {
    setMode(autoMode());
    const h = setInterval(() => setMode(autoMode()), 60_000);
    return () => clearInterval(h);
  }, []);

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); }), []);

  // ---- Firestore 購読（devItems） ----
  useEffect(() => {
    if (!user) { setHydrated(false); setNodes([]); setLastSeen(""); lastRemoteJsonRef.current = ""; return; }
    setHydrated(false);
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(ref, async (snap) => {
      const data = snap.exists() ? snap.data() : {};
      let devItems: Node[] | undefined = Array.isArray(data.devItems) ? (data.devItems as Node[]) : undefined;
      const fsLastSeen: string = typeof data.devLastSeen === "string" ? data.devLastSeen : "";

      // 初回：既存 items から取り込み（本番 items はそのまま温存）
      if (!devItems) {
        const legacy: LegacyItem[] = Array.isArray(data.items) ? data.items : [];
        devItems = migrateFromLegacy(legacy);
        try { await setDoc(ref, { devItems, devLastSeen: dateKey(Date.now()) }, { merge: true }); }
        catch (e) { console.error("dev init failed:", e); }
        return; // 次の snapshot で反映
      }
      lastRemoteJsonRef.current = JSON.stringify({ devItems, devLastSeen: fsLastSeen });
      setNodes(devItems); setLastSeen(fsLastSeen); setHydrated(true);
    });
    return unsub;
  }, [user]);

  // ---- 保存（merge で devItems だけ更新 → 本番 items に触れない） ----
  useEffect(() => {
    if (!hydrated || !user) return;
    const payloadJson = JSON.stringify({ devItems: nodes, devLastSeen: lastSeen });
    if (payloadJson === lastRemoteJsonRef.current) return;
    const h = setTimeout(() => {
      setDoc(doc(db, "users", user.uid), { devItems: nodes, devLastSeen: lastSeen }, { merge: true })
        .catch((e) => console.error("dev save failed:", e));
      lastRemoteJsonRef.current = payloadJson;
    }, 500);
    return () => clearTimeout(h);
  }, [nodes, lastSeen, hydrated, user]);

  // ---- 365日削除（done/missed タスク） ----
  useEffect(() => {
    if (!hydrated) return;
    const th = Date.now() - DELETE_AFTER_DAYS * DAY_MS;
    setNodes((prev) => {
      const next = prev.filter((n) => {
        if (n.type === "task" && n.completedAt && n.completedAt < th) return false;
        if (n.type === "task" && n.missedAt && n.missedAt < th) return false;
        return true;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [hydrated]);

  // ---- 日付繰越（明日タスク→今日 / 未完の今日→また今度）。メモは不変。----
  useEffect(() => {
    if (!hydrated || !user) return;
    const todayK = dateKey(Date.now());
    if (lastSeen && lastSeen !== todayK) {
      const now = Date.now();
      const newlyMissed = nodes.filter((n) => n.type === "task" && n.state === "today").length;
      setNodes((prev) => prev.map((n) => {
        if (n.type !== "task") return n;
        if (n.state === "tomorrow") return { ...n, state: "today" };
        if (n.state === "today") return { ...n, state: "missed", missedAt: now, step: "" };
        return n;
      }));
      showToast(newlyMissed > 0 ? `明日のタスクを今日に繰り越したよ。未達成が${newlyMissed}件あるよ` : "日付が変わったので明日のタスクを今日に繰り越したよ");
    }
    if (lastSeen !== todayK) setLastSeen(todayK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, user]);

  // ---- 操作：notes ----
  function capturePool() {
    const v = capture.trim(); if (!v) return;
    setNodes((prev) => [{ id: uid(), type: "note", title: v, createdAt: Date.now(), subs: [] }, ...prev]);
    setCapture("");
  }
  function delNote(id: string) { setNodes((prev) => prev.filter((n) => n.id !== id)); }
  function addSub(noteId: string, parentId: string) {
    const v = (childInputs[parentId] ?? "").trim(); if (!v) return;
    const note = nodes.find((n) => n.id === noteId && n.type === "note");
    if (!note) return;
    const siblings = parentId === noteId ? (note.subs ?? []) : (findSub(note.subs ?? [], parentId)?.subs ?? []);
    if (siblings.length >= MAX_SUB) { showToast(`子は${MAX_SUB}つまでだよ`); return; }
    setNodes((prev) => prev.map((n) => {
      if (n.id !== noteId || n.type !== "note") return n;
      if (parentId === noteId) return { ...n, subs: [...(n.subs ?? []), { id: uid(), title: v }] };
      return { ...n, subs: addSubUnder(n.subs ?? [], parentId, { id: uid(), title: v }) };
    }));
    setChildInputs((s) => ({ ...s, [parentId]: "" }));
  }
  function delSub(noteId: string, subId: string) {
    setNodes((prev) => prev.map((n) => (n.id === noteId && n.type === "note") ? { ...n, subs: removeSubById(n.subs ?? [], subId) } : n));
  }

  // ---- タスクを生やす（メモは残す・同名のアクティブ重複は作らない） ----
  function spawn(title: string, state: "today" | "tomorrow", sourceId: string | null, parentTitle: string | null) {
    const dup = nodes.some((n) => n.type === "task" && n.sourceId === sourceId && n.title === title && (n.state === "today" || n.state === "tomorrow"));
    if (dup) { showToast("もう予定にあるよ"); return; }
    setNodes((prev) => [...prev, { id: uid(), type: "task", title, createdAt: Date.now(), step: "", state, sourceId, parentTitle }]);
  }
  function noteToToday(n: Node) { spawn(n.title, "today", n.id, null); }
  function noteToTomorrow(n: Node) { spawn(n.title, "tomorrow", n.id, null); }
  function subToToday(note: Node, sub: Sub) { spawn(sub.title, "today", note.id, note.title); }

  // ---- 操作：tasks ----
  function setTaskState(id: string, st: Node["state"]) {
    const now = Date.now();
    setNodes((prev) => prev.map((n) => {
      if (n.id !== id) return n;
      const next: Node = { ...n, state: st };
      if (st === "done") next.completedAt = now; else delete next.completedAt;
      if (st === "missed") next.missedAt = now; else delete next.missedAt;
      return next;
    }));
    if (st !== "today") setFocusId((f) => (f === id ? null : f));
  }
  function taskDone(id: string) { setTaskState(id, "done"); showToast("やった 🌱"); }
  function delTask(id: string) { setNodes((prev) => prev.filter((n) => n.id !== id)); setFocusId((f) => (f === id ? null : f)); }
  function setStep(id: string, step: string) { setNodes((prev) => prev.map((n) => n.id === id ? { ...n, step } : n)); }

  // ---- 編集（note / task 共通、id で更新） ----
  function startEdit(n: Node) { setEditingId(n.id); setEditDraft(n.title); }
  function startEditSub(s: Sub) { setEditingId(s.id); setEditDraft(s.title); }
  function saveEdit() {
    if (!editingId) return; const v = editDraft.trim();
    if (v) setNodes((prev) => prev.map((n) => {
      if (n.id === editingId) return { ...n, title: v };
      if (n.type === "note" && n.subs) return { ...n, subs: editSubById(n.subs, editingId, v) };
      return n;
    }));
    setEditingId(null); setEditDraft("");
  }
  function cancelEdit() { setEditingId(null); setEditDraft(""); }
  function toggleExpand(id: string) { setExpandedId((prev) => (prev === id ? null : id)); }

  // ---- 派生 ----
  const notes = useMemo(() => nodes.filter((n) => n.type === "note").sort((a, b) => b.createdAt - a.createdAt), [nodes]);
  const tasks = useMemo(() => nodes.filter((n) => n.type === "task"), [nodes]);
  const tByState = useCallback((st: Node["state"]) => tasks.filter((n) => n.state === st), [tasks]);
  const todayTasks = useMemo(() => tByState("today"), [tByState]);
  const tomorrowTasks = useMemo(() => tByState("tomorrow"), [tByState]);
  const archiveTh = useMemo(() => Date.now() - ARCHIVE_AFTER_DAYS * DAY_MS, []);
  const doneTasks = useMemo(() => tByState("done").filter((n) => (n.completedAt ?? 0) >= archiveTh).sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)), [tByState, archiveTh]);
  const missedTasks = useMemo(() => tByState("missed").filter((n) => (n.missedAt ?? 0) >= archiveTh).sort((a, b) => (b.missedAt ?? 0) - (a.missedAt ?? 0)), [tByState, archiveTh]);

  const focus = useMemo(() => {
    if (!todayTasks.length) return null;
    return todayTasks.find((n) => n.id === focusId) || todayTasks[0];
  }, [todayTasks, focusId]);
  const rest = useMemo(() => todayTasks.filter((n) => !focus || n.id !== focus.id), [todayTasks, focus]);

  function nextFocus() {
    if (todayTasks.length < 2 || !focus) return;
    const idx = todayTasks.findIndex((n) => n.id === focus.id);
    setFocusId(todayTasks[(idx + 1) % todayTasks.length].id);
  }

  const activeCount = (sourceId: string, st: "today" | "tomorrow") =>
    tasks.filter((n) => n.sourceId === sourceId && n.state === st).length;

  const now = new Date();
  const wd = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  const dateText = `${now.getMonth() + 1}月${now.getDate()}日　${wd}曜`;

  // ---- スタイル ----
  const S: Record<string, CSSProperties> = {
    root: { minHeight: "100vh", width: "100%", display: "flex", flexDirection: "column", background: t.page, color: t.ink, fontFamily: SANS },
    topbar: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 32px 16px" },
    brand: { fontFamily: SERIF, fontSize: 21, fontWeight: 700, color: t.ink, display: "flex", alignItems: "baseline", gap: 9 },
    devTag: { fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: ".1em", color: t.accent, background: t.accentBg, borderRadius: 5, padding: "2px 7px", textTransform: "uppercase" },
    dateLine: { fontSize: 12.5, color: t.faint, marginTop: 2 },
    body: { flex: "1 1 auto", minHeight: 0, display: "flex", overflow: "hidden" },

    leftPane: { flex: "0 0 38%", maxWidth: 460, display: "flex", flexDirection: "column", minHeight: 0, background: t.panel2, border: `1px solid ${night ? t.line : t.edge}`, borderRadius: 18, padding: "20px 18px" },
    paneHead: { display: "flex", alignItems: "baseline", gap: 10 },
    paneTitle: { fontFamily: SERIF, fontSize: 17, fontWeight: 600, color: t.ink },
    paneCount: { fontSize: 13, color: t.faint, fontWeight: 700 },
    paneSub: { fontSize: 11.5, color: t.soft, margin: "4px 0 12px" },
    captureInput: { width: "100%", padding: "11px 14px", borderRadius: 11, border: `1px solid ${t.line}`, background: t.inputBg, color: t.ink, fontSize: 14, outline: "none", fontFamily: SANS, marginBottom: 12 },
    leftScroll: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: 4 },
    kiCard: { background: t.panel, border: `1px solid ${t.line}`, borderRadius: 13, padding: "12px 13px", marginBottom: 9 },
    kiTitle: { fontSize: 14.5, fontWeight: 500, color: t.ink, lineHeight: 1.4, cursor: "text", flex: "1 1 auto", minWidth: 0 },
    noteStatus: { fontSize: 11, fontWeight: 700, color: t.sage, marginTop: 5 },
    editInput: { width: "100%", padding: "4px 9px", borderRadius: 8, border: `1px solid ${t.accent}`, background: t.inputBg, color: t.ink, fontSize: 14.5, outline: "none", fontFamily: SANS },
    subWrap: { marginTop: 11, padding: "12px 12px 13px", borderRadius: 12, background: night ? "rgba(255,255,255,.03)" : "rgba(179,98,46,.05)", border: `1px solid ${t.line}` },
    stepRow: { display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", background: t.inputBg, border: `1px solid ${t.line}`, borderRadius: 9, marginBottom: 6 },
    stepBox: { flex: "0 0 auto", width: 15, height: 15, borderRadius: "50%", border: `1.5px solid ${t.sage}` },
    stepTitle: { flex: "1 1 auto", minWidth: 0, fontSize: 13.5, color: t.ink },
    stepSend: { flex: "0 0 auto", fontSize: 11.5, fontWeight: 700, color: t.sage, cursor: "pointer", whiteSpace: "nowrap" },
    stepDel: { flex: "0 0 auto", fontSize: 11, color: t.faint, cursor: "pointer", padding: "0 2px" },
    subInputRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 3, padding: "0 4px" },
    subInput: { flex: "1 1 auto", minWidth: 0, border: "none", borderBottom: `1px solid ${t.line}`, background: "transparent", color: t.ink, fontSize: 13, outline: "none", padding: "4px 0", fontFamily: SANS },
    subFullNote: { fontSize: 11.5, color: t.faint, marginTop: 6, padding: "0 4px" },
    kiActions: { display: "flex", gap: 6, marginTop: 11, alignItems: "center" },
    delMini: { marginLeft: "auto", fontSize: 12, color: t.faint, cursor: "pointer", padding: "4px 6px" },
    emptyBox: { fontSize: 13, color: t.faint, textAlign: "center", padding: "26px 8px", border: `1px dashed ${t.line}`, borderRadius: 12 },

    rightPane: { flex: "1 1 auto", minWidth: 0, minHeight: 0, background: t.panel, border: `1px solid ${night ? t.line : t.edge}`, borderRadius: 18, boxShadow: night ? "none" : "0 10px 30px -24px rgba(90,60,25,.5)" },
    rightScroll: { height: "100%", overflowY: "auto", padding: "26px 30px 30px" },
    greetBig: { fontFamily: SERIF, fontSize: 30, fontWeight: 600, color: t.ink, lineHeight: 1.2, marginBottom: 20 },
    focusCard: { background: t.panel2, border: `1px solid ${t.edge}`, borderRadius: 16, padding: 26 },
    focusLabel: { fontSize: 12, fontWeight: 700, letterSpacing: ".12em", color: t.accent, marginBottom: 10 },
    ctxLine: { fontSize: 13, color: t.soft, marginBottom: 5, fontWeight: 500 },
    focusTitle: { fontFamily: SERIF, fontSize: 28, fontWeight: 600, color: t.ink, lineHeight: 1.3, marginBottom: 16, cursor: "text" },
    editInputBig: { width: "100%", padding: "5px 11px", borderRadius: 10, border: `1px solid ${t.accent}`, background: t.inputBg, color: t.ink, fontSize: 26, fontWeight: 600, outline: "none", marginBottom: 16, fontFamily: SERIF },
    stepBar: { display: "flex", alignItems: "center", gap: 10, width: "min(440px,100%)", padding: "11px 15px", background: t.accentBg, borderRadius: 11, marginBottom: 18 },
    stepTag: { flex: "0 0 auto", fontSize: 10.5, fontWeight: 700, color: t.accent, letterSpacing: ".08em" },
    stepInput: { flex: "1 1 auto", minWidth: 0, border: "none", background: "transparent", color: t.ink, fontSize: 14.5, fontWeight: 500, outline: "none", fontFamily: SANS },
    focusBtns: { display: "flex", gap: 9 },
    btnPrimary: { padding: "12px 26px", borderRadius: 12, background: t.accent, color: "#fff", fontSize: 14.5, fontWeight: 700, cursor: "pointer", border: "none" },
    btnGhost: { padding: "12px 20px", borderRadius: 12, border: `1px solid ${t.line}`, color: t.soft, fontSize: 13.5, fontWeight: 700, cursor: "pointer", background: "transparent" },
    emptyFocus: { background: t.panel2, border: `1px dashed ${t.edge}`, borderRadius: 16, padding: 30, textAlign: "center", color: t.soft, fontSize: 14, lineHeight: 1.7 },
    sectionHead: { fontSize: 12.5, fontWeight: 700, color: t.soft, margin: "26px 0 10px", display: "flex", gap: 8, alignItems: "center" },
    restRow: { display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", background: t.panel2, border: `1px solid ${t.line}`, borderRadius: 13, marginBottom: 8 },
    restMain: { flex: "1 1 auto", cursor: "pointer", minWidth: 0 },
    ctxLineSm: { fontSize: 11.5, color: t.faint, marginBottom: 2 },
    restTitle: { fontSize: 15, fontWeight: 500, color: t.ink },
    restStep: { fontSize: 12, color: t.faint, marginTop: 2 },
    miniCheck: { flex: "0 0 auto", padding: "9px 16px", borderRadius: 10, border: `1px solid ${t.sage}55`, color: t.sage, background: t.sageBg, fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
    ledgerWrap: { marginTop: 30, paddingTop: 6, borderTop: `1px solid ${t.line}` },
    tomoRow: { display: "flex", alignItems: "center", gap: 12, padding: "9px 4px", borderBottom: `1px solid ${t.line}` },
    tomoRowTitle: { flex: "1 1 auto", minWidth: 0, fontSize: 13.5, color: t.ink },
    tomoToToday: { flex: "0 0 auto", fontSize: 11.5, fontWeight: 700, color: t.sage, cursor: "pointer", whiteSpace: "nowrap" },
    tomoBack: { flex: "0 0 auto", fontSize: 11.5, fontWeight: 700, color: t.faint, cursor: "pointer", whiteSpace: "nowrap" },
    ledgerDim: { fontSize: 12.5, color: t.faint, padding: "8px 4px" },
    reviewToggle: { display: "flex", alignItems: "center", gap: 10, marginTop: 18, padding: "10px 4px", cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: t.soft, borderTop: `1px solid ${t.line}` },
    reviewSummary: { flex: "1 1 auto", fontWeight: 500, color: t.faint },
    reviewCaret: { flex: "0 0 auto", fontSize: 11.5, fontWeight: 700, color: t.accent },
    reviewBody: { paddingTop: 4 },
    ledgerHeadSage: { fontSize: 12.5, fontWeight: 700, color: t.sage, margin: "8px 0 10px" },
    ledgerHeadAmber: { fontSize: 12.5, fontWeight: 700, color: t.amber, margin: "16px 0 8px" },
    doneLine: { fontSize: 13.5, color: t.soft, padding: "4px 0", textDecoration: "line-through", textDecorationColor: t.faint, display: "flex", gap: 8 },
    doneTick: { color: t.sage, textDecoration: "none" },
    missedLine: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 13.5, color: t.soft, padding: "4px 0" },
    missedBtn: { fontSize: 11.5, fontWeight: 700, color: t.amber, cursor: "pointer", whiteSpace: "nowrap" },
    countDim: { color: t.faint, fontWeight: 700 },
    captureWrap: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", width: "100%", maxWidth: 600, margin: "0 auto", padding: "18px 18px 0" },
    doWrap: { flex: "1 1 auto", minHeight: 0, width: "100%", maxWidth: 640, margin: "0 auto" },
    tabBar: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "8px 16px 14px", borderTop: `1px solid ${t.line}`, background: t.panel2 },
  };
  const tabSeg = (on: boolean): CSSProperties => ({ flex: "1 1 0", maxWidth: 160, textAlign: "center", padding: "10px 0", borderRadius: 12, fontSize: 13, fontWeight: 700, cursor: "pointer", color: on ? "#fff" : t.faint, background: on ? t.ink : "transparent" });
  const sendBtn = (color: string, bg: string, br: string): CSSProperties => ({ padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: "pointer", color, background: bg, border: `1px solid ${br}`, whiteSpace: "nowrap" });

  const renderSubs = (note: Node, subs: Sub[], depth: number) => (
    <div style={depth > 1 ? { marginLeft: 12, borderLeft: `1px solid ${t.line}`, paddingLeft: 8 } : undefined}>
      {subs.map((c) => {
        const canNest = depth < MAX_DEPTH;
        const childFull = (c.subs?.length ?? 0) >= MAX_SUB;
        return (
          <div key={c.id}>
            <div style={S.stepRow}>
              <span style={S.stepBox} />
              {editingId === c.id ? (
                <input autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onBlur={saveEdit}
                  onKeyDown={(e) => { if (isEnterSubmit(e)) saveEdit(); if (e.key === "Escape") cancelEdit(); }} style={{ ...S.editInput, flex: "1 1 auto" }} />
              ) : (
                <span onClick={() => startEditSub(c)} style={{ ...S.stepTitle, cursor: "text" }} title="クリックで編集">{c.title}</span>
              )}
              <span onClick={() => subToToday(note, c)} style={S.stepSend}>今日へ</span>
              <span onClick={() => delSub(note.id, c.id)} style={S.stepDel}>✕</span>
            </div>
            {c.subs && c.subs.length > 0 && renderSubs(note, c.subs, depth + 1)}
            {canNest && !childFull && (
              <div style={{ ...S.subInputRow, marginLeft: 12 }}>
                <span style={{ color: t.accent, fontWeight: 700, fontSize: 14, flex: "0 0 auto" }}>＋</span>
                <input value={childInputs[c.id] ?? ""} onChange={(e) => setChildInputs((s) => ({ ...s, [c.id]: e.target.value }))}
                  onKeyDown={(e) => { if (isEnterSubmit(e)) addSub(note.id, c.id); }} placeholder="さらに分解…（5段まで）" style={S.subInput} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // ---- 認証ゲート ----
  if (authLoading) {
    return <main style={{ ...S.root, alignItems: "center", justifyContent: "center" }}><div style={{ color: t.soft, fontSize: 14 }}>読み込み中...</div></main>;
  }
  if (!user) {
    return (
      <main style={{ ...S.root, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 380, width: "100%", textAlign: "center" }}>
          <div style={{ fontFamily: SERIF, fontSize: 34, fontWeight: 700, color: t.ink }}>TaskLog</div>
          <p style={{ fontSize: 13.5, color: t.soft, lineHeight: 1.7, margin: "12px 0 20px" }}>
            頭の中で処理しすぎて止まる時のための、タスクを外部化する装置。<br />同期のためログインが必要。
          </p>
          <button onClick={() => { setAuthError(null); signInWithPopup(auth, googleProvider).catch((e) => { const m = authErrorMessage((e as { code?: string }).code ?? ""); if (m) setAuthError(m); }); }} disabled={authBusy} style={{ ...S.btnPrimary, width: "100%", padding: "13px 0" }}>
            Google でログイン
          </button>

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0", color: t.faint, fontSize: 11 }}>
            <span style={{ height: 1, flex: 1, background: t.line }} />または メール / パスワード<span style={{ height: 1, flex: 1, background: t.line }} />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, textAlign: "left" }}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="メールアドレス" autoComplete="email" style={{ ...S.captureInput, marginBottom: 0 }} />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (isEnterSubmit(e)) handleEmailAuth(); }} placeholder="パスワード（6文字以上）" autoComplete={authMode === "signup" ? "new-password" : "current-password"} style={{ ...S.captureInput, marginBottom: 0 }} />
            {authError && <p style={{ fontSize: 12, color: "#b3442b", margin: "2px 2px 0" }}>{authError}</p>}
            <button onClick={handleEmailAuth} disabled={authBusy} style={{ ...S.btnGhost, width: "100%", padding: "11px 0", color: t.accent, borderColor: `${t.accent}55`, background: t.accentBg }}>
              {authBusy ? "処理中..." : authMode === "signin" ? "メールでログイン" : "新規登録"}
            </button>
            <button onClick={() => { setAuthMode((m) => (m === "signin" ? "signup" : "signin")); setAuthError(null); }} style={{ background: "transparent", border: "none", color: t.faint, fontSize: 12, cursor: "pointer", padding: "4px 0" }}>
              {authMode === "signin" ? "アカウント未作成 → 新規登録する" : "アカウントを持っている → ログインする"}
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ---- 本体 ----
  return (
    <main style={S.root}>
      <div style={S.topbar}>
        <div>
          <div style={S.brand}>TaskLog</div>
          <div style={S.dateLine}>{dateText}　·　{user.email}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button onClick={() => signOut(auth).catch(() => {})} style={{ fontSize: 12, color: t.faint, background: "transparent", border: `1px solid ${t.line}`, borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>ログアウト</button>
        </div>
      </div>

      <div style={S.body}>
        {view === "capture" ? (
        /* 気になること（消えないメモ）＝書く専用 */
        <div style={S.captureWrap}>
          <div style={S.paneHead}>
            <span style={S.paneTitle}>気になること</span>
            <span style={S.paneCount}>{notes.length}</span>
          </div>
          <div style={S.paneSub}>消えない場所。出すことに集中。</div>
          <input value={capture} onChange={(e) => setCapture(e.target.value)} onKeyDown={(e) => { if (isEnterSubmit(e)) capturePool(); }} placeholder="書き出す…（Enter）" style={S.captureInput} />
          <div style={S.leftScroll}>
            {notes.map((note) => {
              const open = expandedId === note.id;
              const subs = note.subs ?? [];
              const full = subs.length >= MAX_SUB;
              const tdy = activeCount(note.id, "today");
              const tmr = activeCount(note.id, "tomorrow");
              const parts = [tdy ? `今日 ${tdy}` : null, tmr ? `明日 ${tmr}` : null].filter(Boolean);
              return (
                <div key={note.id} style={S.kiCard}>
                  <div style={{ display: "flex", alignItems: "center" }}>
                    {editingId === note.id ? (
                      <input autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onBlur={saveEdit}
                        onKeyDown={(e) => { if (isEnterSubmit(e)) saveEdit(); if (e.key === "Escape") cancelEdit(); }} style={S.editInput} />
                    ) : (
                      <span onClick={() => startEdit(note)} style={S.kiTitle} title="クリックで編集">{note.title}</span>
                    )}
                  </div>
                  {parts.length > 0 && <div style={S.noteStatus}>→ {parts.join(" ・ ")}</div>}

                  {open && (
                    <div style={S.subWrap}>
                      {subs.length > 0 && renderSubs(note, subs, 1)}
                      {!full ? (
                        <div style={S.subInputRow}>
                          <span style={{ color: t.accent, fontWeight: 700, fontSize: 15, flex: "0 0 auto" }}>＋</span>
                          <input value={childInputs[note.id] ?? ""} onChange={(e) => setChildInputs((s) => ({ ...s, [note.id]: e.target.value }))}
                            onKeyDown={(e) => { if (isEnterSubmit(e)) addSub(note.id, note.id); }} placeholder="やることを1つ" style={S.subInput} />
                        </div>
                      ) : (
                        <div style={S.subFullNote}>子は5つまで。さらに分解は各項目の下から。</div>
                      )}
                    </div>
                  )}

                  <div style={S.kiActions}>
                    <div onClick={() => toggleExpand(note.id)} style={sendBtn(open ? "#fff" : t.accent, open ? t.accent : t.accentBg, open ? t.accent : `${t.accent}44`)}>{open ? "とじる" : "小さくする"}</div>
                    <div onClick={() => noteToToday(note)} style={sendBtn(t.sage, t.sageBg, `${t.sage}44`)}>今日へ</div>
                    <div onClick={() => noteToTomorrow(note)} style={sendBtn(t.amber, t.amberBg, `${t.amber}44`)}>明日へ</div>
                    <div onClick={() => delNote(note.id)} style={S.delMini}>✕</div>
                  </div>
                </div>
              );
            })}
            {notes.length === 0 && <div style={S.emptyBox}>頭は空っぽ。いいことだ。</div>}
          </div>
        </div>
        ) : (
        /* 今日の卓（タスク）＝やる専用 */
        <div style={S.doWrap}>
          <div style={S.rightScroll}>
            <div style={S.greetBig}>{night ? "おつかれさま。" : "おはよう。"}</div>

            {focus ? (
              <div style={S.focusCard}>
                <div style={S.focusLabel}>いま、これ</div>
                {focus.parentTitle && <div style={S.ctxLine}>{focus.parentTitle} ／</div>}
                {editingId === focus.id ? (
                  <input autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onBlur={saveEdit}
                    onKeyDown={(e) => { if (isEnterSubmit(e)) saveEdit(); if (e.key === "Escape") cancelEdit(); }} style={S.editInputBig} />
                ) : (
                  <div onClick={() => startEdit(focus)} style={S.focusTitle} title="クリックで編集">{focus.title}</div>
                )}
                <div style={S.stepBar}>
                  <span style={S.stepTag}>はじめの一歩</span>
                  <input value={focus.step ?? ""} onChange={(e) => setStep(focus.id, e.target.value)} placeholder="まず、何を開く？" style={S.stepInput} />
                </div>
                <div style={S.focusBtns}>
                  <button onClick={() => taskDone(focus.id)} style={S.btnPrimary}>できた</button>
                  <button onClick={nextFocus} style={S.btnGhost}>次の1件</button>
                  <button onClick={() => setTaskState(focus.id, "tomorrow")} style={S.btnGhost}>明日へ</button>
                </div>
              </div>
            ) : (
              <div style={S.emptyFocus}>今日のぶんは、ぜんぶ。<br />「気になる」から「今日へ」送ろう。</div>
            )}

            {rest.length > 0 && (
              <>
                <div style={S.sectionHead}>このあとの今日　<span style={S.countDim}>{rest.length}</span></div>
                {rest.map((it) => (
                  <div key={it.id} style={S.restRow}>
                    <div onClick={() => setFocusId(it.id)} style={S.restMain}>
                      {it.parentTitle && <div style={S.ctxLineSm}>{it.parentTitle} ／</div>}
                      {editingId === it.id ? (
                        <input autoFocus value={editDraft} onClick={(e) => e.stopPropagation()} onChange={(e) => setEditDraft(e.target.value)} onBlur={saveEdit}
                          onKeyDown={(e) => { if (isEnterSubmit(e)) saveEdit(); if (e.key === "Escape") cancelEdit(); }} style={S.editInput} />
                      ) : (
                        <div onClick={(e) => { e.stopPropagation(); startEdit(it); }} style={S.restTitle} title="クリックで編集">{it.title}</div>
                      )}
                      {it.step && <div style={S.restStep}>はじめの一歩 — {it.step}</div>}
                    </div>
                    <div onClick={() => taskDone(it.id)} style={S.miniCheck}>できた</div>
                  </div>
                ))}
              </>
            )}

            <div style={S.ledgerWrap}>
              <div style={S.sectionHead}>あした　<span style={S.countDim}>{tomorrowTasks.length}</span></div>
              {tomorrowTasks.map((it) => (
                <div key={it.id} style={S.tomoRow}>
                  {editingId === it.id ? (
                    <input autoFocus value={editDraft} onChange={(e) => setEditDraft(e.target.value)} onBlur={saveEdit}
                      onKeyDown={(e) => { if (isEnterSubmit(e)) saveEdit(); if (e.key === "Escape") cancelEdit(); }} style={{ ...S.editInput, flex: "1 1 auto" }} />
                  ) : (
                    <span onClick={() => startEdit(it)} style={S.tomoRowTitle} title="クリックで編集">{it.title}</span>
                  )}
                  <span onClick={() => setTaskState(it.id, "today")} style={S.tomoToToday}>今日へ</span>
                  <span onClick={() => delTask(it.id)} style={S.tomoBack}>もどす</span>
                </div>
              ))}
              {tomorrowTasks.length === 0 && <div style={S.ledgerDim}>まだ無い</div>}

              <div onClick={() => setShowReview((v) => !v)} style={S.reviewToggle}>
                <span>ふりかえり</span>
                <span style={S.reviewSummary}>
                  {[doneTasks.length ? `できた ${doneTasks.length}` : null, missedTasks.length ? `また今度 ${missedTasks.length}` : null].filter(Boolean).join("　·　") || "まだ無い"}
                </span>
                <span style={S.reviewCaret}>{showReview ? "閉じる" : "ひらく"}</span>
              </div>
              {showReview && (
                <div style={S.reviewBody}>
                  <div style={S.ledgerHeadSage}>できた　<span style={S.countDim}>{doneTasks.length}</span></div>
                  {doneTasks.map((it) => <div key={it.id} style={S.doneLine}><span style={S.doneTick}>／</span>{it.title}</div>)}
                  {missedTasks.length > 0 && (
                    <>
                      <div style={S.ledgerHeadAmber}>また今度　<span style={S.countDim}>{missedTasks.length}</span></div>
                      {missedTasks.map((it) => (
                        <div key={it.id} style={S.missedLine}><span>{it.title}</span><span onClick={() => setTaskState(it.id, "today")} style={S.missedBtn}>今日にする</span></div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        )}
      </div>

      <div style={S.tabBar}>
        <div onClick={() => setView("capture")} style={tabSeg(view === "capture")}>気になる</div>
        <div onClick={() => setView("do")} style={tabSeg(view === "do")}>やること</div>
      </div>

      {toast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", borderRadius: 999, border: `1px solid ${t.sage}66`, background: t.panel, color: t.sage, padding: "9px 18px", fontSize: 13.5, fontWeight: 700, boxShadow: "0 8px 24px -12px rgba(0,0,0,.4)", zIndex: 50 }}>
          {toast}
        </div>
      )}
    </main>
  );
}
