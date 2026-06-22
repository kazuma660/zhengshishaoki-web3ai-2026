"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragStartEvent,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { auth, db, googleProvider } from "./lib/firebase";
import {
  onAuthStateChanged,
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
const ARCHIVE_AFTER_DAYS = 7;
const DELETE_AFTER_DAYS = 365;
const DAY_MS = 86_400_000;

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

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [lastSeen, setLastSeen] = useState<string>("");
  const [title, setTitle] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [childInputs, setChildInputs] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [showDoneArchive, setShowDoneArchive] = useState(false);
  const [showMissedArchive, setShowMissedArchive] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const lastRemoteJsonRef = useRef<string>("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const draggedDescendants = useMemo(
    () => (draggedId ? collectDescendants(items, draggedId) : new Set<string>()),
    [draggedId, items]
  );

  function handleDragStart(e: DragStartEvent) {
    setDraggedId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setDraggedId(null);
    const { active, over } = e;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;
    if (overId === "pool-root") {
      setItems((prev) =>
        prev.map((it) =>
          it.id === activeId ? { ...it, parentId: undefined } : it
        )
      );
      return;
    }
    if (collectDescendants(items, activeId).has(overId)) return;
    setItems((prev) =>
      prev.map((it) => (it.id === activeId ? { ...it, parentId: overId } : it))
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
      showToast("日付が変わったので明日やる事を今日に繰り越したよ");
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
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
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
          autoFocus
          type="text"
          value={editDraft}
          onChange={(e) => setEditDraft(e.target.value)}
          onBlur={saveEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveEdit();
            if (e.key === "Escape") cancelEdit();
          }}
          className="flex-1 min-w-0 rounded border border-emerald-500/50 bg-neutral-950 px-2 py-0.5 text-sm outline-none"
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

  function renderPoolNode(it: Item, depth: number) {
    const kids = childrenByParent.get(it.id) ?? [];
    const isExpanded = expandedIds.has(it.id);
    const hasKids = kids.length > 0;
    const isCollapsed = collapsedIds.has(it.id);
    const dropDisabled = draggedDescendants.has(it.id);
    return (
      <DraggableDroppable key={it.id} id={it.id} disabled={dropDisabled}>
        {({ attributes, listeners, setDragRef, setDropRef, style, isOver }) => (
      <li
        ref={setDropRef}
        style={style}
        className={`rounded-md border bg-neutral-900 ${
          isOver ? "border-emerald-400 ring-2 ring-emerald-400/30" : "border-neutral-800"
        }`}
      >
        <div className="flex items-start gap-2 px-3 py-2">
          <button
            ref={setDragRef as React.Ref<HTMLButtonElement>}
            {...attributes}
            {...listeners}
            className="text-neutral-500 hover:text-neutral-200 text-xs px-1 shrink-0 cursor-grab active:cursor-grabbing touch-none mt-0.5"
            aria-label="ドラッグして移動"
          >
            ⋮⋮
          </button>
          {hasKids ? (
            <button
              onClick={() => toggleCollapse(it.id)}
              className="text-neutral-500 hover:text-neutral-200 text-xs px-1 shrink-0 w-4 text-center mt-0.5"
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
          <button
            onClick={() => toggleExpand(it.id)}
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 shrink-0"
          >
            細かく
          </button>
          <button
            onClick={() => toggleToday(it.id)}
            className="rounded-md border border-emerald-500/50 bg-emerald-500/15 px-2 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 shrink-0"
          >
            今日
          </button>
          <button
            onClick={() => toggleTomorrow(it.id)}
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 shrink-0"
          >
            明日
          </button>
          <button
            onClick={() => deleteItem(it.id)}
            className="text-neutral-600 hover:text-red-400 text-xs px-1 shrink-0 mt-0.5"
            aria-label="削除"
          >
            ✕
          </button>
        </div>
        {hasKids && !isCollapsed && (
          <ul className="border-l-2 border-emerald-500/30 ml-4 pl-2 pr-1 py-1 my-1 space-y-1">
            {kids.map((c) => renderPoolNode(c, depth + 1))}
          </ul>
        )}
        {isExpanded && (
          <div className="border-t border-sky-500/20 bg-sky-500/5 px-3 py-2 flex gap-2">
            <input
              type="text"
              value={childInputs[it.id] ?? ""}
              onChange={(e) =>
                setChildInputs((s) => ({
                  ...s,
                  [it.id]: e.target.value,
                }))
              }
              placeholder="数えられる単位で（例：英単語20個）"
              className="flex-1 min-w-0 rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-sky-500"
            />
            <button
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
      <main className="flex-1 bg-neutral-950 text-neutral-100 flex items-center justify-center px-4">
        <div className="max-w-md w-full space-y-6 text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            TaskLog <span className="text-emerald-400">v5</span>
          </h1>
          <p className="text-sm text-neutral-400 leading-relaxed">
            頭の中で処理しすぎて止まる時のための、タスクを外部化する装置。
            <br />
            複数端末で同期・バックアップするためログインが必要。
          </p>
          <button
            onClick={() =>
              signInWithPopup(auth, googleProvider).catch((e) =>
                console.error("Sign-in failed:", e)
              )
            }
            className="w-full rounded-md bg-emerald-500 px-6 py-3 text-sm font-semibold text-neutral-950 hover:bg-emerald-400"
          >
            Google でログイン
          </button>
          <p className="text-[10px] text-neutral-600">
            データは Firestore に保存・端末間で同期されます
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-3xl font-bold tracking-tight">
              TaskLog <span className="text-emerald-400">v5</span>
            </h1>
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate text-xs text-neutral-500">
                {user.email}
              </span>
              <button
                onClick={() =>
                  signOut(auth).catch((e) => console.error("Sign-out failed:", e))
                }
                className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
              >
                ログアウト
              </button>
            </div>
          </div>
          <p className="text-sm text-neutral-400">
            前夜に明日やる事を置く。最初の一歩が目の前にある状態で朝を迎えよう。
          </p>
        </header>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 space-y-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="気になってる事は？"
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

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-emerald-300">
            今日やる事（{todayItems.length}）
          </h2>
          {todayItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              まだ無い。下から「明日やる」を押すか、上の入力で直接置こう。
            </div>
          ) : (
            <ul className="space-y-2">
              {todayItems.map((it) => (
                <li
                  key={it.id}
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    {renderEditableTitle(it, "flex-1 min-w-0 text-sm font-medium")}
                    <button
                      onClick={() => deleteItem(it.id)}
                      className="text-neutral-600 hover:text-red-400 text-xs px-1 shrink-0"
                      aria-label="削除"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    type="text"
                    value={it.miniStep ?? ""}
                    onChange={(e) => setMiniStep(it.id, e.target.value)}
                    placeholder="最初の一歩を書く（例：ファイルを開く）"
                    className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-emerald-500"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => doneToday(it.id)}
                      className="flex-1 rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-400"
                    >
                      やった
                    </button>
                    <button
                      onClick={() => promoteToTomorrow(it.id)}
                      className="flex-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/20"
                    >
                      明日へ
                    </button>
                    <button
                      onClick={() => toggleToday(it.id)}
                      className="flex-1 rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      外す
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {tomorrowItems.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-sky-300">
              明日やる事（{tomorrowItems.length}）
            </h2>
            <ul className="space-y-2">
              {tomorrowItems.map((it) => (
                <li
                  key={it.id}
                  className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    {renderEditableTitle(it, "flex-1 min-w-0 text-sm font-medium")}
                    <button
                      onClick={() => deleteItem(it.id)}
                      className="text-neutral-600 hover:text-red-400 text-xs px-1 shrink-0"
                      aria-label="削除"
                    >
                      ✕
                    </button>
                  </div>
                  <input
                    type="text"
                    value={it.miniStep ?? ""}
                    onChange={(e) => setMiniStep(it.id, e.target.value)}
                    placeholder="最初の一歩を書く（例：ファイルを開く）"
                    className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs outline-none focus:border-sky-500"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => doneToday(it.id)}
                      className="flex-1 rounded-md bg-emerald-500 px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-400"
                    >
                      やった
                    </button>
                    <button
                      onClick={() => promoteToToday(it.id)}
                      className="flex-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20"
                    >
                      今日へ
                    </button>
                    <button
                      onClick={() => toggleTomorrow(it.id)}
                      className="flex-1 rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      外す
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-xs text-neutral-600">日付が変わると自動で「今日やる事」に移ります</p>
          </section>
        )}

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-neutral-300">
            気になってる事（{poolRoots.length}）
          </h2>
          <DndContext
            sensors={sensors}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setDraggedId(null)}
          >
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
          </DndContext>
          <p className="text-[10px] text-neutral-600">
            ⋮⋮ をドラッグして並び替え／別の項目の上にドロップで子タスクに、上のゾーンにドロップで一番上の階層に戻せる
          </p>
        </section>

        {(missedItems.length > 0 || missedArchived.length > 0) && (
          <section className="space-y-2">
            {missedItems.length > 0 && (
              <>
                <h2 className="text-sm font-semibold text-amber-300">
                  未達成（{missedItems.length}）
                </h2>
                <ul className="space-y-1.5">
                  {missedItems.map((it) => (
                    <li
                      key={it.id}
                      className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                    >
                      <span className="text-amber-400 shrink-0">!</span>
                      {renderEditableTitle(it, "flex-1 min-w-0 break-words text-sm text-neutral-300")}
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
                        className="text-neutral-600 hover:text-red-400 text-xs px-1 shrink-0"
                        aria-label="削除"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {missedArchived.length > 0 && (
              <div className="rounded-md border border-neutral-800 bg-neutral-900/30">
                <button
                  onClick={() => setShowMissedArchive((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-xs text-neutral-500 hover:text-neutral-300"
                >
                  <span>📦 未達成アーカイブ（{missedArchived.length}）— 7日以上前</span>
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
                        {renderEditableTitle(it, "flex-1 min-w-0 break-words")}
                        <button
                          onClick={() => restoreMissed(it.id)}
                          className="text-neutral-500 hover:text-neutral-200 shrink-0"
                        >
                          戻す
                        </button>
                        <button
                          onClick={() => deleteItem(it.id)}
                          className="text-neutral-600 hover:text-red-400 px-1 shrink-0"
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
          </section>
        )}

        {(doneItems.length > 0 || doneArchived.length > 0) && (
          <section className="space-y-2">
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
                      {renderEditableTitle(it, "flex-1 min-w-0 break-words text-sm text-neutral-400 line-through")}
                      <button
                        onClick={() => restoreDone(it.id)}
                        className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 shrink-0"
                      >
                        戻す
                      </button>
                      <button
                        onClick={() => deleteItem(it.id)}
                        className="text-neutral-600 hover:text-red-400 text-xs px-1 shrink-0"
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
                        {renderEditableTitle(it, "flex-1 min-w-0 break-words line-through")}
                        <button
                          onClick={() => restoreDone(it.id)}
                          className="text-neutral-500 hover:text-neutral-200 shrink-0"
                        >
                          戻す
                        </button>
                        <button
                          onClick={() => deleteItem(it.id)}
                          className="text-neutral-600 hover:text-red-400 px-1 shrink-0"
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

        <footer className="pt-4 text-center text-xs text-neutral-600">
          TaskLog v5 — 最初のワンステップで、何もしない日を作らない
        </footer>
      </div>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-emerald-500/40 bg-neutral-900 px-4 py-2 text-sm text-emerald-300 shadow-lg z-50">
          {toast}
        </div>
      )}
    </main>
  );
}
