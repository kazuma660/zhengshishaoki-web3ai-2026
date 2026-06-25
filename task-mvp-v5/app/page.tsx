"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CollisionDetection,
  DndContext,
  DragEndEvent,
  DragStartEvent,
  PointerSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { auth, db, googleProvider } from "./lib/firebase";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  User,
} from "firebase/auth";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

type Item = {
  id: string;
  title: string;
  createdAt: number;
  touches: number[];
  letGoAt?: number;
  importance?: 1 | 2 | 3;
  deadline?: string;
  miniStep?: string;
  isToday?: boolean;
  isTomorrow?: boolean;
  parentId?: string;
  completedAt?: number;
  missedAt?: number;
};

type AddTarget = "pool" | "today" | "tomorrow";

const STORAGE_ITEMS = "tasklog:items:v2";
const STORAGE_UI = "tasklog:ui:v2";
const ARCHIVE_AFTER_DAYS = 7;
const DELETE_AFTER_DAYS = 365;
const DAY_MS = 86_400_000;
const MAX_DEPTH = 5;

function getDepth(items: Item[], id: string): number {
  const byId = new Map(items.map((it) => [it.id, it]));
  let depth = 1;
  let cur = byId.get(id);
  while (cur?.parentId) {
    depth++;
    cur = byId.get(cur.parentId);
    if (depth > 100) break;
  }
  return depth;
}

function getParentChain(items: Item[], id: string): string | null {
  const byId = new Map(items.map((x) => [x.id, x]));
  const titles: string[] = [];
  let cur = byId.get(id);
  while (cur?.parentId) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    titles.unshift(parent.title);
    cur = parent;
    if (titles.length > MAX_DEPTH) break;
  }
  return titles.length ? titles.join(" / ") : null;
}

function getSubtreeHeight(items: Item[], rootId: string): number {
  const childrenByParent = new Map<string, string[]>();
  items.forEach((it) => {
    if (it.parentId) {
      const arr = childrenByParent.get(it.parentId) ?? [];
      arr.push(it.id);
      childrenByParent.set(it.parentId, arr);
    }
  });
  let maxHeight = 0;
  const stack: Array<{ id: string; height: number }> = [
    { id: rootId, height: 0 },
  ];
  while (stack.length) {
    const { id, height } = stack.pop()!;
    if (height > maxHeight) maxHeight = height;
    (childrenByParent.get(id) ?? []).forEach((cid) =>
      stack.push({ id: cid, height: height + 1 })
    );
  }
  return maxHeight;
}

function DraggableDroppable({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: (args: {
    attributes: React.HTMLAttributes<HTMLElement>;
    listeners: Record<string, (event: React.SyntheticEvent) => void> | undefined;
    setDragRef: (node: HTMLElement | null) => void;
    setDropRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    isOver: boolean;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({ id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id, disabled });
  const style: React.CSSProperties = {
    opacity: isDragging ? 0.4 : 1,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
  };
  return children({
    attributes: attributes as React.HTMLAttributes<HTMLElement>,
    listeners: listeners as Record<string, (event: React.SyntheticEvent) => void> | undefined,
    setDragRef,
    setDropRef,
    style,
    isOver,
    isDragging,
  });
}

function RootDropZone({ visible }: { visible: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "pool-root" });
  if (!visible) return null;
  return (
    <div
      ref={setNodeRef}
      className={`mb-2 rounded-md border-2 border-dashed p-2 text-center text-xs ${
        isOver
          ? "border-emerald-400 bg-emerald-500/10 text-emerald-300"
          : "border-neutral-700 text-neutral-500"
      }`}
    >
      ⬆ ここに離すと一番上の階層に
    </div>
  );
}

// ハンドル限定のドラッグ可能ラッパー（今日/明日カード用。入力欄やボタンとは衝突しない）
function Draggable({
  id,
  children,
}: {
  id: string;
  children: (args: {
    attributes: React.HTMLAttributes<HTMLElement>;
    listeners: Record<string, (event: React.SyntheticEvent) => void> | undefined;
    setDragRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id });
  const style: React.CSSProperties = {
    opacity: isDragging ? 0.4 : 1,
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
  };
  return children({
    attributes: attributes as React.HTMLAttributes<HTMLElement>,
    listeners: listeners as
      | Record<string, (event: React.SyntheticEvent) => void>
      | undefined,
    setDragRef: setNodeRef,
    style,
    isDragging,
  });
}

// セクション全体のドロップ枠（ここに離すとそのセクションへ移動）
function SectionDropZone({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg transition-colors ${
        isOver
          ? "ring-2 ring-emerald-400/50 bg-emerald-500/5"
          : active
            ? "ring-1 ring-neutral-700/60"
            : ""
      }`}
    >
      {children}
    </div>
  );
}

function collectDescendants(items: Item[], rootId: string): Set<string> {
  const result = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    items.forEach((it) => {
      if (it.parentId && result.has(it.parentId) && !result.has(it.id)) {
        result.add(it.id);
        grew = true;
      }
    });
  }
  return result;
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const ZONE_IDS = new Set(["zone-today", "zone-tomorrow", "zone-pool", "pool-root"]);

// 指/カーソルの位置で判定（吸い付く）。項目の上にいる時は列ゾーンより項目を優先＝
// 「重ねたら子タスク化／余白に落としたら移動」を登録順に左右されず確定させる。
const dropCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  const itemHit = within.find((c) => !ZONE_IDS.has(String(c.id)));
  return itemHit ? [itemHit] : within;
};

// IME変換確定のEnterを誤submitしないためのガード。
// 変換中(isComposing / keyCode 229)はsubmit扱いにしない。確定後の単独Enterのみ通す。
function isEnterSubmit(e: React.KeyboardEvent): boolean {
  return e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229;
}

function authErrorMessage(code: string): string {
  switch (code) {
    case "auth/invalid-email":
      return "メールアドレスの形式が正しくありません。";
    case "auth/user-not-found":
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "メールかパスワードが違います。";
    case "auth/email-already-in-use":
      return "このメールは既に登録済みです。「ログイン」を試してください。";
    case "auth/weak-password":
      return "パスワードは6文字以上にしてください。";
    case "auth/operation-not-allowed":
      return "メール/パスワードログインがまだ有効化されていません（Firebase 側の設定が必要）。";
    case "auth/too-many-requests":
      return "試行回数が多すぎます。少し待って再度お試しください。";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "";
    default:
      return "ログインに失敗しました。もう一度お試しください。";
  }
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [lastSeen, setLastSeen] = useState<string>("");
  const [title, setTitle] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [childInputs, setChildInputs] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [showDoneArchive, setShowDoneArchive] = useState(false);
  const [showMissedArchive, setShowMissedArchive] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [sectionsCollapsed, setSectionsCollapsed] = useState<{
    today: boolean;
    pool: boolean;
    tomorrow: boolean;
    missed: boolean;
  }>({ today: false, pool: false, tomorrow: false, missed: true });
  const lastRemoteJsonRef = useRef<string>("");
  // 入力欄・ボタンの上でカードのドラッグが始まらないようにする
  // PointerSensor=onPointerDown / TouchSensor=onTouchStart の両方を止める必要がある
  const stopDrag = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const draggedDescendants = useMemo(
    () => (draggedId ? collectDescendants(items, draggedId) : new Set<string>()),
    [draggedId, items]
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  async function handleEmailAuth() {
    const em = email.trim();
    if (!em || !password) {
      setAuthError("メールとパスワードを入力してください。");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (authMode === "signup") {
        await createUserWithEmailAndPassword(auth, em, password);
      } else {
        await signInWithEmailAndPassword(auth, em, password);
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setAuthError(authErrorMessage(code) || "ログインに失敗しました。");
    } finally {
      setAuthBusy(false);
    }
  }

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_UI);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          setSectionsCollapsed({
            today: !!parsed.today,
            pool: !!parsed.pool,
            tomorrow: !!parsed.tomorrow,
            missed: !!parsed.missed,
          });
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_UI, JSON.stringify(sectionsCollapsed));
    } catch {}
  }, [sectionsCollapsed]);

  function toggleSection(key: "today" | "pool" | "tomorrow" | "missed") {
    setSectionsCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function handleDragStart(e: DragStartEvent) {
    setDraggedId(String(e.active.id));
  }

  function moveToSection(id: string, target: AddTarget) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { isToday: _t, isTomorrow: _tm, missedAt: _m, ...rest } = it;
        if (target === "today") return { ...rest, isToday: true };
        if (target === "tomorrow") return { ...rest, isTomorrow: true };
        // pool: フラグに加え parentId と miniStep も外して、独立した「気になる」項目にする
        const { parentId: _p, miniStep: _ms, ...top } = rest;
        return top;
      })
    );
  }

  function handleDragEnd(e: DragEndEvent) {
    setDraggedId(null);
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    // 「落とす場所」だけで決まる：
    // 列ゾーン or 最上位ゾーンに落とす＝移動
    if (overId === "zone-today") return moveToSection(activeId, "today");
    if (overId === "zone-tomorrow") return moveToSection(activeId, "tomorrow");
    if (overId === "zone-pool" || overId === "pool-root")
      return moveToSection(activeId, "pool");

    // 別の項目に重ねる＝子タスクにする（気になるへ入れる）
    if (collectDescendants(items, activeId).has(overId)) return;
    const newActiveDepth = getDepth(items, overId) + 1;
    const subtreeHeight = getSubtreeHeight(items, activeId);
    if (newActiveDepth + subtreeHeight > MAX_DEPTH) {
      showToast(`階層は${MAX_DEPTH}層までだよ`);
      return;
    }
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== activeId) return it;
        // 子にする時は今日/明日/未達成フラグと一歩を外して、気になるの子に収める
        const { isToday: _t, isTomorrow: _tm, missedAt: _m, miniStep: _ms, ...rest } = it;
        return { ...rest, parentId: overId };
      })
    );
  }

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!user) {
      setHydrated(false);
      setItems([]);
      setLastSeen("");
      lastRemoteJsonRef.current = "";
      return;
    }
    setHydrated(false);
    const ref = doc(db, "users", user.uid);
    const unsub = onSnapshot(ref, async (snap) => {
      if (!snap.exists()) {
        let migrated: Item[] = [];
        try {
          const raw = localStorage.getItem(STORAGE_ITEMS);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) migrated = parsed;
          }
        } catch {}
        const initial = { items: migrated, lastSeen: dateKey(Date.now()) };
        try {
          await setDoc(ref, initial);
        } catch (e) {
          console.error("Failed to init user doc:", e);
        }
        return;
      }
      const data = snap.data();
      const fsItems: Item[] = Array.isArray(data.items) ? data.items : [];
      const fsLastSeen: string =
        typeof data.lastSeen === "string" ? data.lastSeen : "";
      lastRemoteJsonRef.current = JSON.stringify({
        items: fsItems,
        lastSeen: fsLastSeen,
      });
      setItems(fsItems);
      setLastSeen(fsLastSeen);
      setHydrated(true);
    });
    return unsub;
  }, [user]);

  useEffect(() => {
    if (!hydrated || !user) return;
    const payload = { items, lastSeen };
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === lastRemoteJsonRef.current) return;
    const handle = setTimeout(() => {
      const ref = doc(db, "users", user.uid);
      setDoc(ref, payload).catch((e) => console.error("Failed to save:", e));
      lastRemoteJsonRef.current = payloadJson;
    }, 500);
    return () => clearTimeout(handle);
  }, [items, lastSeen, hydrated, user]);

  useEffect(() => {
    if (!hydrated) return;
    const deleteThreshold = Date.now() - DELETE_AFTER_DAYS * DAY_MS;
    setItems((prev) => {
      const next = prev.filter((it) => {
        if (it.completedAt && it.completedAt < deleteThreshold) return false;
        if (it.missedAt && it.missedAt < deleteThreshold) return false;
        return true;
      });
      return next.length === prev.length ? prev : next;
    });
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || !user) return;
    const todayKey = dateKey(Date.now());
    if (lastSeen && lastSeen !== todayKey) {
      const now = Date.now();
      const newlyMissed = items.filter(
        (it) => it.isToday && !it.completedAt
      ).length;
      setItems((prev) =>
        prev.map((it) => {
          if (it.isTomorrow) {
            const { isTomorrow: _, ...rest } = it;
            return { ...rest, isToday: true };
          }
          if (it.isToday && !it.completedAt) {
            const { isToday: _, miniStep: _ms, ...rest } = it;
            return { ...rest, missedAt: now };
          }
          return it;
        })
      );
      showToast(
        newlyMissed > 0
          ? `明日やる事を今日に繰り越したよ。未達成が${newlyMissed}件あるよ`
          : "日付が変わったので明日やる事を今日に繰り越したよ"
      );
    }
    if (lastSeen !== todayKey) setLastSeen(todayKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, user]);

  function addItem(target: AddTarget) {
    const t = title.trim();
    if (!t) return;
    const flags: Partial<Item> =
      target === "today"
        ? { isToday: true }
        : target === "tomorrow"
          ? { isTomorrow: true }
          : {};
    setItems((prev) => [
      {
        id: crypto.randomUUID(),
        title: t,
        createdAt: Date.now(),
        touches: [],
        ...flags,
      },
      ...prev,
    ]);
    setTitle("");
  }

  function addChild(parentId: string) {
    const t = (childInputs[parentId] ?? "").trim();
    if (!t) return;
    if (getDepth(items, parentId) >= MAX_DEPTH) {
      showToast(`階層は${MAX_DEPTH}層までだよ`);
      return;
    }
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        title: t,
        createdAt: Date.now(),
        touches: [],
        parentId,
      },
    ]);
    setChildInputs((s) => ({ ...s, [parentId]: "" }));
  }

  function deleteItem(id: string) {
    setItems((prev) => {
      const toDelete = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        prev.forEach((it) => {
          if (it.parentId && toDelete.has(it.parentId) && !toDelete.has(it.id)) {
            toDelete.add(it.id);
            grew = true;
          }
        });
      }
      return prev.filter((it) => !toDelete.has(it.id));
    });
  }

  function toggleToday(id: string) {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, isToday: !it.isToday, isTomorrow: false }
          : it
      )
    );
  }

  function toggleTomorrow(id: string) {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, isTomorrow: !it.isTomorrow, isToday: false }
          : it
      )
    );
  }

  function promoteToToday(id: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { isTomorrow: _t, missedAt: _m, ...rest } = it;
        return { ...rest, isToday: true };
      })
    );
  }

  function promoteToTomorrow(id: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { isToday: _t, missedAt: _m, ...rest } = it;
        return { ...rest, isTomorrow: true };
      })
    );
  }

  function restoreMissed(id: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { missedAt: _m, ...rest } = it;
        return rest;
      })
    );
  }

  function toggleExpand(id: string) {
    // 同じidなら閉じる、違うidなら単一要素に置換（同時に開くのは最大1つ）。
    // 書きかけテキストは childInputs に残るので閉じても消えない。
    setExpandedIds((prev) => (prev.has(id) ? new Set() : new Set([id])));
  }

  function toggleCollapse(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setMiniStep(id: string, step: string) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, miniStep: step } : it))
    );
  }

  function doneToday(id: string) {
    const now = Date.now();
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { miniStep: _ms, isToday: _t, isTomorrow: _tm, ...rest } = it;
        return { ...rest, touches: [...it.touches, now], completedAt: now };
      })
    );
    showToast("やった 🌱 やったことに貯まった");
  }

  function restoreDone(id: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { completedAt: _c, ...rest } = it;
        return rest;
      })
    );
  }

  function startEdit(it: Item) {
    setEditingId(it.id);
    setEditDraft(it.title);
  }

  function saveEdit() {
    if (!editingId) return;
    const next = editDraft.trim();
    if (next) {
      setItems((prev) =>
        prev.map((it) => (it.id === editingId ? { ...it, title: next } : it))
      );
    }
    setEditingId(null);
    setEditDraft("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft("");
  }

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Item[]>();
    items.forEach((it) => {
      if (
        it.parentId &&
        !it.letGoAt &&
        !it.isToday &&
        !it.isTomorrow &&
        !it.completedAt &&
        !it.missedAt
      ) {
        const arr = map.get(it.parentId) ?? [];
        arr.push(it);
        map.set(it.parentId, arr);
      }
    });
    return map;
  }, [items]);

  const todayItems = useMemo(
    () => items.filter((it) => it.isToday && !it.letGoAt && !it.completedAt && !it.missedAt),
    [items]
  );

  const tomorrowItems = useMemo(
    () => items.filter((it) => it.isTomorrow && !it.letGoAt && !it.completedAt && !it.missedAt),
    [items]
  );

  const poolRoots = useMemo(() => {
    const byId = new Map(items.map((it) => [it.id, it]));
    const isOut = (it: Item) =>
      it.isToday ||
      it.isTomorrow ||
      it.letGoAt ||
      it.completedAt ||
      it.missedAt;
    return items
      .filter((it) => {
        if (isOut(it)) return false;
        if (!it.parentId) return true;
        const parent = byId.get(it.parentId);
        if (!parent) return true;
        if (isOut(parent)) return true;
        return false;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [items]);

  const archiveThreshold = useMemo(() => Date.now() - ARCHIVE_AFTER_DAYS * DAY_MS, []);

  const doneItems = useMemo(
    () =>
      items
        .filter(
          (it) =>
            it.completedAt &&
            it.completedAt >= archiveThreshold &&
            !it.letGoAt
        )
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
    [items, archiveThreshold]
  );

  const doneArchived = useMemo(
    () =>
      items
        .filter(
          (it) =>
            it.completedAt && it.completedAt < archiveThreshold && !it.letGoAt
        )
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
    [items, archiveThreshold]
  );

  const missedItems = useMemo(
    () =>
      items
        .filter(
          (it) =>
            it.missedAt &&
            it.missedAt >= archiveThreshold &&
            !it.letGoAt &&
            !it.completedAt
        )
        .sort((a, b) => (b.missedAt ?? 0) - (a.missedAt ?? 0)),
    [items, archiveThreshold]
  );

  const missedArchived = useMemo(
    () =>
      items
        .filter(
          (it) =>
            it.missedAt &&
            it.missedAt < archiveThreshold &&
            !it.letGoAt &&
            !it.completedAt
        )
        .sort((a, b) => (b.missedAt ?? 0) - (a.missedAt ?? 0)),
    [items, archiveThreshold]
  );

  function renderEditableTitle(
    it: Item,
    baseClass: string,
    suffix?: React.ReactNode
  ) {
    if (editingId === it.id) {
      return (
        <input
          {...stopDrag}
          autoFocus
          type="text"
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
          onBlur={saveEdit}
          onKeyDown={(e) => {
            if (isEnterSubmit(e)) saveEdit();
            if (e.key === "Escape") cancelEdit();
          }}
          className={`${baseClass} rounded border border-emerald-500/50 bg-neutral-950 px-2 py-0.5 outline-none`}
        />
      );
    }
    return (
      <span
        onClick={() => startEdit(it)}
        className={`${baseClass} cursor-text hover:text-emerald-300`}
        title="クリックで編集"
      >
        {it.title}
        {suffix}
      </span>
    );
  }

  function renderTitleWithParent(
    it: Item,
    baseClass: string,
    suffix?: React.ReactNode
  ) {
    const parentChain = getParentChain(items, it.id);
    if (!parentChain) {
      return renderEditableTitle(it, baseClass, suffix);
    }
    const innerClass = baseClass
      .replace(/\bflex-1\b/g, "")
      .replace(/\bmin-w-0\b/g, "")
      .trim();
    return (
      <div className="flex-1 min-w-0">
        <div className="text-xs text-neutral-400 truncate">
          {parentChain} /
        </div>
        {renderEditableTitle(it, `block w-full ${innerClass}`, suffix)}
      </div>
    );
  }

  function renderPoolNode(it: Item, depth: number) {
    const kids = childrenByParent.get(it.id) ?? [];
    const isExpanded = expandedIds.has(it.id);
    const hasKids = kids.length > 0;
    const isCollapsed = collapsedIds.has(it.id);
    const dropDisabled = draggedDescendants.has(it.id);
    const atMaxDepth = getDepth(items, it.id) >= MAX_DEPTH;
    return (
      <DraggableDroppable key={it.id} id={it.id} disabled={dropDisabled}>
        {({ attributes, listeners, setDragRef, setDropRef, style, isOver }) => (
      <li
        ref={(node) => {
          setDragRef(node);
          setDropRef(node);
        }}
        style={style}
        {...attributes}
        {...listeners}
        className={`rounded-md border bg-neutral-900 cursor-grab active:cursor-grabbing ${
          isOver ? "border-emerald-400 ring-2 ring-emerald-400/30 bg-emerald-500/10" : "border-neutral-800"
        }`}
      >
        <div className="flex items-start gap-2 px-3 py-2">
          <span
            title="ドラッグで移動／別の項目に重ねると子タスク"
            aria-hidden="true"
            className="text-neutral-500 text-xs px-1 shrink-0 mt-0.5 select-none"
          >
            ⋮⋮
          </span>
          {hasKids ? (
            <button
              {...stopDrag}
              onClick={() => toggleCollapse(it.id)}
              className="text-neutral-300 hover:text-neutral-100 text-xs px-1 shrink-0 w-4 text-center mt-0.5"
              aria-label={isCollapsed ? "展開" : "畳む"}
            >
              {isCollapsed ? "▶" : "▼"}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          {renderEditableTitle(
            it,
            "flex-1 min-w-0 break-words text-sm",
            hasKids && isCollapsed ? (
              <span className="ml-2 text-xs text-neutral-500">（{kids.length}）</span>
            ) : undefined
          )}
          {!atMaxDepth && (
            <button
              {...stopDrag}
              onClick={() => toggleExpand(it.id)}
              title="細かくする（分解）"
              aria-label={isExpanded ? "細かく入力を閉じる" : "細かくする"}
              className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-sm font-semibold text-sky-300 hover:bg-sky-500/20 shrink-0 w-7 text-center leading-none"
            >
              {isExpanded ? "－" : "＋"}
            </button>
          )}
          <button
            {...stopDrag}
            onClick={() => toggleToday(it.id)}
            className="rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 shrink-0"
          >
            今日
          </button>
          <button
            {...stopDrag}
            onClick={() => toggleTomorrow(it.id)}
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 shrink-0"
          >
            明日
          </button>
          <button
            {...stopDrag}
            onClick={() => deleteItem(it.id)}
            className="text-neutral-400 hover:text-red-400 text-xs px-1 shrink-0 mt-0.5"
            aria-label="削除"
          >
            ✕
          </button>
        </div>
        {hasKids && !isCollapsed && (
          <ul className="border-l-2 border-emerald-500/50 ml-4 pl-2 pr-1 py-1 my-1 space-y-1">
            {kids.map((c) => renderPoolNode(c, depth + 1))}
          </ul>
        )}
        {isExpanded && (
          <div className="border-t border-sky-500/20 bg-sky-500/5 px-3 py-2 flex gap-2">
            <input
              {...stopDrag}
              type="text"
              value={childInputs[it.id] ?? ""}
              onChange={(e) =>
                setChildInputs((s) => ({
                  ...s,
                  [it.id]: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                if (isEnterSubmit(e)) addChild(it.id);
              }}
              placeholder="数えられる単位で（例：英単語20個）"
              className="flex-1 min-w-0 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-sky-500"
            />
            <button
              {...stopDrag}
              onClick={() => addChild(it.id)}
              className="rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-sky-400 shrink-0"
            >
              追加
            </button>
          </div>
        )}
      </li>
        )}
      </DraggableDroppable>
    );
  }

  if (authLoading) {
    return (
      <main className="flex-1 bg-neutral-950 text-neutral-100 flex items-center justify-center">
        <div className="text-sm text-neutral-500">読み込み中...</div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex-1 bg-neutral-950 text-neutral-100 flex items-center justify-center px-4 py-8">
        <div className="max-w-md w-full space-y-5 text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            TaskLog <span className="text-emerald-400">v5</span>
          </h1>
          <p className="text-sm text-neutral-400 leading-relaxed">
            頭の中で処理しすぎて止まる時のための、タスクを外部化する装置。
            <br />
            複数端末で同期・バックアップするためログインが必要。
          </p>
          <button
            onClick={() => {
              setAuthError(null);
              signInWithPopup(auth, googleProvider).catch((e) => {
                console.error("Sign-in failed:", e);
                const msg = authErrorMessage((e as { code?: string }).code ?? "");
                if (msg) setAuthError(msg);
              });
            }}
            disabled={authBusy}
            className="w-full rounded-md bg-emerald-500 px-6 py-3 text-sm font-semibold text-neutral-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            Google でログイン
          </button>

          <div className="flex items-center gap-3 text-[10px] text-neutral-600">
            <span className="h-px flex-1 bg-neutral-800" />
            または メール / パスワード
            <span className="h-px flex-1 bg-neutral-800" />
          </div>

          <div className="space-y-2 text-left">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="メールアドレス"
              autoComplete="email"
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-base sm:text-sm outline-none focus:border-emerald-500"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (isEnterSubmit(e)) handleEmailAuth();
              }}
              placeholder="パスワード（6文字以上）"
              autoComplete={authMode === "signup" ? "new-password" : "current-password"}
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-base sm:text-sm outline-none focus:border-emerald-500"
            />
            {authError && <p className="text-xs text-red-400">{authError}</p>}
            <button
              onClick={handleEmailAuth}
              disabled={authBusy}
              className="w-full rounded-md border border-emerald-500/50 bg-emerald-500/10 px-6 py-2.5 text-sm font-semibold text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
            >
              {authBusy
                ? "処理中..."
                : authMode === "signin"
                  ? "メールでログイン"
                  : "新規登録"}
            </button>
            <button
              onClick={() => {
                setAuthMode((m) => (m === "signin" ? "signup" : "signin"));
                setAuthError(null);
              }}
              className="w-full text-center text-xs text-neutral-500 hover:text-neutral-300"
            >
              {authMode === "signin"
                ? "アカウント未作成 → 新規登録する"
                : "アカウントを持っている → ログインする"}
            </button>
          </div>

          <p className="text-[10px] text-neutral-600">
            データは Firestore に保存・端末間で同期されます
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-2xl space-y-6 lg:max-w-6xl xl:max-w-[1536px]">
        <header className="space-y-2 lg:mx-auto lg:max-w-2xl">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-3xl font-bold tracking-tight">
              TaskLog <span className="text-emerald-400">v5</span>
            </h1>
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate text-xs text-neutral-500">
                {user.email}
              </span>
              <button
                onClick={() => setConfirmingLogout(true)}
                className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
              >
                ログアウト
              </button>
            </div>
          </div>
        </header>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 space-y-2 lg:mx-auto lg:max-w-2xl">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (isEnterSubmit(e)) addItem("pool");
            }}
            placeholder="気になってる事は？（Enter で「置く」）"
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-base sm:text-sm outline-none focus:border-emerald-500"
          />
          <div className="flex gap-2">
            <button
              onClick={() => addItem("pool")}
              className="flex-1 rounded-md bg-neutral-700 px-3 py-2 text-sm font-semibold text-neutral-100 hover:bg-neutral-600"
            >
              置く
            </button>
            <button
              onClick={() => addItem("today")}
              className="flex-1 rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-neutral-950 hover:bg-emerald-400"
            >
              今日やる
            </button>
            <button
              onClick={() => addItem("tomorrow")}
              className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-semibold text-neutral-950 hover:bg-sky-400"
            >
              明日やる
            </button>
          </div>
        </section>

        <DndContext
          sensors={sensors}
          collisionDetection={dropCollision}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggedId(null)}
        >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-4 xl:gap-6">
        <section className="space-y-2 xl:order-1 xl:max-h-[75vh] xl:overflow-y-auto xl:pr-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-emerald-300">
              今日やる事（{todayItems.length}）
            </h2>
            <button
              onClick={() => toggleSection("today")}
              className="text-neutral-400 hover:text-neutral-100 text-xs px-1"
              aria-label={sectionsCollapsed.today ? "展開" : "畳む"}
            >
              {sectionsCollapsed.today ? "▶" : "▼"}
            </button>
          </div>
          {!sectionsCollapsed.today && (
          <SectionDropZone id="zone-today" active={!!draggedId}>
          {todayItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              まだ無い。下から「明日やる」を押すか、上の入力で直接置こう。
            </div>
          ) : (
            <ul className="space-y-2">
              {todayItems.map((it) => (
                <Draggable key={it.id} id={it.id}>
                  {({ attributes, listeners, setDragRef, style }) => (
                <li
                  ref={setDragRef}
                  style={style}
                  {...attributes}
                  {...listeners}
                  className="rounded-md border border-emerald-500/50 bg-emerald-500/5 p-3 space-y-2 cursor-grab active:cursor-grabbing"
                >
                  <div className="flex items-center gap-2">
                    {renderTitleWithParent(it, "flex-1 min-w-0 text-sm font-medium")}
                    <button
                      {...stopDrag}
                      onClick={() => deleteItem(it.id)}
                      className="text-neutral-400 hover:text-red-400 text-xs px-1 shrink-0"
                      aria-label="削除"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    {...stopDrag}
                    type="text"
                    value={it.miniStep ?? ""}
                    onChange={(e) => setMiniStep(it.id, e.target.value)}
                    placeholder="最初の一歩を書く（例：ファイルを開く）"
                    className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-emerald-500"
                  />
                  <div className="flex gap-2">
                    <button
                      {...stopDrag}
                      onClick={() => doneToday(it.id)}
                      className="flex-1 rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-400"
                    >
                      やった
                    </button>
                    <button
                      {...stopDrag}
                      onClick={() => promoteToTomorrow(it.id)}
                      className="flex-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20"
                    >
                      明日へ
                    </button>
                    <button
                      {...stopDrag}
                      onClick={() => toggleToday(it.id)}
                      className="flex-1 rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      外す
                    </button>
                  </div>
                </li>
                  )}
                </Draggable>
              ))}
            </ul>
          )}
          </SectionDropZone>
          )}
        </section>

        <section className="space-y-2 xl:order-4 xl:max-h-[75vh] xl:overflow-y-auto xl:pr-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-sky-300">
              明日やる事（{tomorrowItems.length}）
            </h2>
            <button
              onClick={() => toggleSection("tomorrow")}
              className="text-neutral-400 hover:text-neutral-100 text-xs px-1"
              aria-label={sectionsCollapsed.tomorrow ? "展開" : "畳む"}
            >
              {sectionsCollapsed.tomorrow ? "▶" : "▼"}
            </button>
          </div>
          {!sectionsCollapsed.tomorrow && (
          <>
          <SectionDropZone id="zone-tomorrow" active={!!draggedId}>
          {tomorrowItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              まだ無い。前夜に「明日やる」を置いておくと、朝の判断ゼロで動ける。
            </div>
          ) : (
            <ul className="space-y-2">
              {tomorrowItems.map((it) => (
                <Draggable key={it.id} id={it.id}>
                  {({ attributes, listeners, setDragRef, style }) => (
                <li
                  ref={setDragRef}
                  style={style}
                  {...attributes}
                  {...listeners}
                  className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 space-y-2 cursor-grab active:cursor-grabbing"
                >
                  <div className="flex items-center gap-2">
                    {renderTitleWithParent(it, "flex-1 min-w-0 text-sm font-medium")}
                    <button
                      {...stopDrag}
                      onClick={() => deleteItem(it.id)}
                      className="text-neutral-400 hover:text-red-400 text-xs px-1 shrink-0"
                      aria-label="削除"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    {...stopDrag}
                    type="text"
                    value={it.miniStep ?? ""}
                    onChange={(e) => setMiniStep(it.id, e.target.value)}
                    placeholder="最初の一歩を書く（例：ファイルを開く）"
                    className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      {...stopDrag}
                      onClick={() => doneToday(it.id)}
                      className="flex-1 rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-400"
                    >
                      やった
                    </button>
                    <button
                      {...stopDrag}
                      onClick={() => promoteToToday(it.id)}
                      className="flex-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20"
                    >
                      今日へ
                    </button>
                    <button
                      {...stopDrag}
                      onClick={() => toggleTomorrow(it.id)}
                      className="flex-1 rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      外す
                    </button>
                  </div>
                </li>
                  )}
                </Draggable>
              ))}
            </ul>
          )}
          </SectionDropZone>
          <p className="text-xs text-neutral-600">日付が変わると自動で「今日やる事」に移ります</p>
          </>
          )}
        </section>

        <section className="space-y-2 xl:order-3 xl:max-h-[75vh] xl:overflow-y-auto xl:pr-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-neutral-300">
              気になってる事（{poolRoots.length}）
            </h2>
            <button
              onClick={() => toggleSection("pool")}
              className="text-neutral-400 hover:text-neutral-100 text-xs px-1"
              aria-label={sectionsCollapsed.pool ? "展開" : "畳む"}
            >
              {sectionsCollapsed.pool ? "▶" : "▼"}
            </button>
          </div>
          {!sectionsCollapsed.pool && (
          <>
          <SectionDropZone id="zone-pool" active={!!draggedId}>
            <RootDropZone visible={!!draggedId} />
            {poolRoots.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
                まだ無い。上から気軽に置こう。
              </div>
            ) : (
              <ul className="space-y-2">
                {poolRoots.map((it) => renderPoolNode(it, 0))}
              </ul>
            )}
          </SectionDropZone>
          <p className="text-[10px] text-neutral-600">
            カードを掴んで、別の項目に重ねると子タスク／今日・明日の列に落とすと移動／上のゾーンで最上位へ戻せる
          </p>
          </>
          )}
        </section>

        <section className="space-y-2 xl:order-2 xl:max-h-[75vh] xl:overflow-y-auto xl:pr-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-amber-300">
              未達成（{missedItems.length}）
            </h2>
            <button
              onClick={() => toggleSection("missed")}
              className="text-neutral-400 hover:text-neutral-100 text-xs px-1"
              aria-label={sectionsCollapsed.missed ? "展開" : "畳む"}
            >
              {sectionsCollapsed.missed ? "▶" : "▼"}
            </button>
          </div>
          {!sectionsCollapsed.missed && (
          <>
          {missedItems.length === 0 && missedArchived.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              まだ無い。やれなかった日は淡々と記録、責めない。
            </div>
          ) : (
            <>
              {missedItems.length > 0 && (
                <ul className="space-y-1.5">
                  {missedItems.map((it) => (
                    <li
                      key={it.id}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                    >
                      <span className="text-amber-400 shrink-0">!</span>
                      {renderTitleWithParent(it, "flex-1 min-w-0 break-words text-sm text-neutral-300")}
                      <button
                        onClick={() => promoteToToday(it.id)}
                        className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 shrink-0"
                      >
                        今日やる
                      </button>
                      <button
                        onClick={() => restoreMissed(it.id)}
                        className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
                      >
                        戻す
                      </button>
                      <button
                        onClick={() => deleteItem(it.id)}
                        className="text-neutral-400 hover:text-red-400 text-xs px-1 shrink-0"
                        aria-label="削除"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {missedArchived.length > 0 && (
                <div className="rounded-md border border-neutral-800 bg-neutral-900/30">
                  <button
                    onClick={() => setShowMissedArchive((v) => !v)}
                    className="flex w-full items-center justify-between px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300"
                  >
                    <span>📦 アーカイブ（{missedArchived.length}）</span>
                    <span>{showMissedArchive ? "閉じる" : "開く"}</span>
                  </button>
                  {showMissedArchive && (
                    <ul className="space-y-1 px-3 pb-3 text-xs">
                      {missedArchived.map((it) => (
                        <li
                          key={it.id}
                          className="flex items-center gap-2 text-neutral-500"
                        >
                          <span className="shrink-0">!</span>
                          {renderTitleWithParent(it, "flex-1 min-w-0 break-words")}
                          <button
                            onClick={() => restoreMissed(it.id)}
                            className="text-neutral-300 hover:text-neutral-100 shrink-0"
                          >
                            戻す
                          </button>
                          <button
                            onClick={() => deleteItem(it.id)}
                            className="text-neutral-400 hover:text-red-400 px-1 shrink-0"
                            aria-label="削除"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
          </>
          )}
        </section>
        </div>
        </DndContext>

        {(doneItems.length > 0 || doneArchived.length > 0) && (
          <section className="space-y-2 lg:mx-auto lg:max-w-2xl">
            {doneItems.length > 0 && (
              <>
                <h2 className="text-sm font-semibold text-neutral-300">
                  やったこと（{doneItems.length}）
                </h2>
                <ul className="space-y-1.5">
                  {doneItems.map((it) => (
                    <li
                      key={it.id}
                      className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2"
                    >
                      <span className="text-emerald-400 shrink-0">✓</span>
                      {renderTitleWithParent(it, "flex-1 min-w-0 break-words text-sm text-neutral-400 line-through")}
                      <button
                        onClick={() => restoreDone(it.id)}
                        className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
                      >
                        戻す
                      </button>
                      <button
                        onClick={() => deleteItem(it.id)}
                        className="text-neutral-400 hover:text-red-400 text-xs px-1 shrink-0"
                        aria-label="削除"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {doneArchived.length > 0 && (
              <div className="rounded-md border border-neutral-800 bg-neutral-900/30">
                <button
                  onClick={() => setShowDoneArchive((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300"
                >
                  <span>📦 やったことアーカイブ（{doneArchived.length}）— 7日以上前</span>
                  <span>{showDoneArchive ? "閉じる" : "開く"}</span>
                </button>
                {showDoneArchive && (
                  <ul className="space-y-1 px-3 pb-3 text-xs">
                    {doneArchived.map((it) => (
                      <li
                        key={it.id}
                        className="flex items-center gap-2 text-neutral-500"
                      >
                        <span className="text-emerald-500/60 shrink-0">✓</span>
                        {renderTitleWithParent(it, "flex-1 min-w-0 break-words line-through")}
                        <button
                          onClick={() => restoreDone(it.id)}
                          className="text-neutral-300 hover:text-neutral-100 shrink-0"
                        >
                          戻す
                        </button>
                        <button
                          onClick={() => deleteItem(it.id)}
                          className="text-neutral-400 hover:text-red-400 px-1 shrink-0"
                          aria-label="削除"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="px-3 pb-2 text-[10px] text-neutral-600">365日以上前のものは自動削除されます</p>
              </div>
            )}
          </section>
        )}

      </div>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-emerald-500/40 bg-neutral-900 px-4 py-2 text-sm text-emerald-300 shadow-lg z-50">
          {toast}
        </div>
      )}
      {confirmingLogout && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setConfirmingLogout(false)}
        >
          <div
            className="w-full max-w-xs rounded-lg border border-neutral-700 bg-neutral-900 p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <p className="text-sm font-semibold text-neutral-100">ログアウトする？</p>
              <p className="text-xs text-neutral-500">
                再ログインで戻れます。データは消えません。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmingLogout(false)}
                className="flex-1 rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:text-neutral-100"
              >
                やめる
              </button>
              <button
                onClick={() => {
                  setConfirmingLogout(false);
                  signOut(auth).catch((e) =>
                    console.error("Sign-out failed:", e)
                  );
                }}
                className="flex-1 rounded-md bg-neutral-200 px-3 py-2 text-xs font-semibold text-neutral-900 hover:bg-white"
              >
                ログアウト
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
