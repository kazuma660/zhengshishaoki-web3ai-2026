"use client";

import { useEffect, useMemo, useState } from "react";

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
  parentId?: string;
  completedAt?: number;
};

const STORAGE_ITEMS = "tasklog:items:v2";

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [childInputs, setChildInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_ITEMS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setItems(parsed);
      }
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_ITEMS, JSON.stringify(items));
  }, [items, hydrated]);

  function addItem(asToday: boolean) {
    const t = title.trim();
    if (!t) return;
    setItems((prev) => [
      {
        id: crypto.randomUUID(),
        title: t,
        createdAt: Date.now(),
        touches: [],
        ...(asToday ? { isToday: true } : {}),
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
      prev.map((it) => (it.id === id ? { ...it, isToday: !it.isToday } : it))
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
        const { miniStep: _ms, isToday: _t, ...rest } = it;
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

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  const childrenByParent = useMemo(() => {
    const map = new Map<string, Item[]>();
    items.forEach((it) => {
      if (it.parentId && !it.letGoAt && !it.isToday && !it.completedAt) {
        const arr = map.get(it.parentId) ?? [];
        arr.push(it);
        map.set(it.parentId, arr);
      }
    });
    return map;
  }, [items]);

  const todayItems = useMemo(
    () => items.filter((it) => it.isToday && !it.letGoAt && !it.completedAt),
    [items]
  );

  const poolRoots = useMemo(() => {
    const byId = new Map(items.map((it) => [it.id, it]));
    return items
      .filter((it) => {
        if (it.isToday || it.letGoAt || it.completedAt) return false;
        if (!it.parentId) return true;
        const parent = byId.get(it.parentId);
        if (!parent) return true;
        if (parent.isToday || parent.letGoAt || parent.completedAt) return true;
        return false;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [items]);

  const doneItems = useMemo(
    () =>
      items
        .filter((it) => it.completedAt && !it.letGoAt)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
    [items]
  );

  function renderPoolNode(it: Item, depth: number) {
    const kids = childrenByParent.get(it.id) ?? [];
    const isExpanded = expandedIds.has(it.id);
    const hasKids = kids.length > 0;
    const isCollapsed = collapsedIds.has(it.id);
    return (
      <li
        key={it.id}
        className="rounded-md border border-neutral-800 bg-neutral-900"
      >
        <div className="flex items-start gap-2 px-3 py-2">
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
          <div className="flex-1 min-w-0 break-words text-sm">
            {it.title}
            {hasKids && isCollapsed && (
              <span className="ml-2 text-xs text-neutral-500">（{kids.length}）</span>
            )}
          </div>
          <button
            onClick={() => toggleExpand(it.id)}
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 shrink-0"
          >
            細かく
          </button>
          <button
            onClick={() => toggleToday(it.id)}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 shrink-0"
          >
            明日やる
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
    );
  }

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">
            TaskLog <span className="text-emerald-400">v4.1</span>
          </h1>
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
              onClick={() => addItem(false)}
              className="flex-1 rounded-md bg-neutral-700 px-4 py-2 text-sm font-semibold text-neutral-100 hover:bg-neutral-600"
            >
              置く
            </button>
            <button
              onClick={() => addItem(true)}
              className="flex-1 rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-emerald-400"
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
                    <div className="flex-1 min-w-0 text-sm font-medium">{it.title}</div>
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
                      onClick={() => toggleToday(it.id)}
                      className="rounded-md border border-neutral-700 px-3 py-2 text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      外す
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-neutral-300">
            気になってる事（{poolRoots.length}）
          </h2>
          {poolRoots.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              まだ無い。上から気軽に置こう。
            </div>
          ) : (
            <ul className="space-y-2">
              {poolRoots.map((it) => renderPoolNode(it, 0))}
            </ul>
          )}
        </section>

        {doneItems.length > 0 && (
          <section className="space-y-2">
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
                  <span className="flex-1 min-w-0 break-words text-sm text-neutral-400 line-through">
                    {it.title}
                  </span>
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
          </section>
        )}

        <footer className="pt-4 text-center text-xs text-neutral-600">
          TaskLog v4.1 — 最初のワンステップで、何もしない日を作らない
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
