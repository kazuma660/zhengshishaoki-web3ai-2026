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
};

const STORAGE_ITEMS = "tasklog:items:v2";

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysSince(ts: number): number {
  return Math.floor((startOfDay(Date.now()) - startOfDay(ts)) / 86400000);
}

function daysUntil(deadline?: string): number | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - startOfDay(Date.now())) / 86400000);
}

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showLetGo, setShowLetGo] = useState(false);
  const [breakdownId, setBreakdownId] = useState<string | null>(null);
  const [breakdownSteps, setBreakdownSteps] = useState<string[]>([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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

  function addItem() {
    const t = title.trim();
    if (!t) return;
    setItems((prev) => [
      {
        id: crypto.randomUUID(),
        title: t,
        createdAt: Date.now(),
        touches: [],
      },
      ...prev,
    ]);
    setTitle("");
  }

  function touchItem(id: string) {
    const now = Date.now();
    setItems((prev) =>
      prev.map((it) =>
        it.id === id ? { ...it, touches: [...it.touches, now] } : it
      )
    );
  }

  function letGo(id: string) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, letGoAt: Date.now() } : it))
    );
    setExpandedId(null);
  }

  function restore(id: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { letGoAt: _ignored, ...rest } = it;
        return rest;
      })
    );
  }

  function removeForever(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  function setImportance(id: string, v: 1 | 2 | 3 | undefined) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, importance: v } : it))
    );
  }

  function setDeadline(id: string, v: string | undefined) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, deadline: v } : it))
    );
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function fetchBreakdown(id: string, itemTitle: string) {
    if (breakdownId === id) {
      setBreakdownId(null);
      return;
    }
    setBreakdownId(id);
    setBreakdownSteps([]);
    setBreakdownLoading(true);
    try {
      const res = await fetch("/api/breakdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: itemTitle }),
      });
      const data = await res.json();
      setBreakdownSteps(Array.isArray(data.steps) ? data.steps : []);
    } catch {
      setBreakdownSteps([]);
    } finally {
      setBreakdownLoading(false);
    }
  }

  function pickMiniStep(id: string, step: string) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, miniStep: step } : it))
    );
    setBreakdownId(null);
    setBreakdownSteps([]);
  }

  function doneMiniStep(id: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { miniStep: _done, ...rest } = it;
        return { ...rest, touches: [...it.touches, Date.now()] };
      })
    );
    showToast("1分の前進 🌱 ちゃんと積み上がった");
  }

  function clearMiniStep(id: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const { miniStep: _cleared, ...rest } = it;
        return rest;
      })
    );
  }

  const active = useMemo(
    () =>
      items
        .filter((it) => !it.letGoAt)
        .sort((a, b) => {
          const aLast = a.touches[a.touches.length - 1] ?? a.createdAt;
          const bLast = b.touches[b.touches.length - 1] ?? b.createdAt;
          return bLast - aLast;
        }),
    [items]
  );

  const letGoList = useMemo(
    () =>
      items
        .filter((it) => !!it.letGoAt)
        .sort((a, b) => (b.letGoAt ?? 0) - (a.letGoAt ?? 0)),
    [items]
  );

  const touchesByDay = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((it) => {
      it.touches.forEach((ts) => {
        const k = dayKey(ts);
        map.set(k, (map.get(k) ?? 0) + 1);
      });
    });
    return map;
  }, [items]);

  const heatmap = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dow = today.getDay();
    const lastSat = new Date(today.getTime() + (6 - dow) * 86400000);
    const weeks: { key: string; label: string; count: number; future: boolean }[][] = [];
    for (let w = 11; w >= 0; w--) {
      const col: { key: string; label: string; count: number; future: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(lastSat.getTime() - (w * 7 + (6 - d)) * 86400000);
        const k = dayKey(date.getTime());
        col.push({
          key: k,
          label: `${date.getMonth() + 1}/${date.getDate()}`,
          count: touchesByDay.get(k) ?? 0,
          future: date.getTime() > today.getTime(),
        });
      }
      weeks.push(col);
    }
    return weeks;
  }, [touchesByDay]);

  const streak = useMemo(() => {
    let s = 0;
    for (let i = 0; i < 365; i++) {
      const k = dayKey(Date.now() - i * 86400000);
      if ((touchesByDay.get(k) ?? 0) > 0) s++;
      else if (i === 0) continue;
      else break;
    }
    return s;
  }, [touchesByDay]);

  const todayCount = touchesByDay.get(dayKey(Date.now())) ?? 0;
  const totalTouches = useMemo(
    () => items.reduce((acc, it) => acc + it.touches.length, 0),
    [items]
  );

  function heatColor(count: number, future: boolean): string {
    if (future) return "bg-neutral-900/40";
    if (count === 0) return "bg-neutral-800";
    if (count === 1) return "bg-emerald-900";
    if (count === 2) return "bg-emerald-700";
    if (count <= 4) return "bg-emerald-500";
    return "bg-emerald-300";
  }

  function touchDots(n: number) {
    const max = 5;
    const filled = Math.min(n, max);
    const extra = n > max ? n - max : 0;
    return (
      <div className="flex items-center gap-0.5">
        {Array.from({ length: max }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full ${
              i < filled ? "bg-emerald-400" : "bg-neutral-700"
            }`}
          />
        ))}
        {extra > 0 && (
          <span className="ml-1 text-[10px] text-emerald-400">+{extra}</span>
        )}
      </div>
    );
  }

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">
            TaskLog <span className="text-emerald-400">v3</span>
          </h1>
          <p className="text-sm text-neutral-400">
            気になってる事を置く場所。触れたら積み上がるし、手放しても咎められない。
            動けない日は<span className="text-emerald-400">「1分だけ」</span>がAIと一緒に最初の一歩を出してくれる。
          </p>
        </header>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
              placeholder="気になってる事は？"
              className="flex-1 min-w-0 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-base sm:text-sm outline-none focus:border-emerald-500"
            />
            <button
              onClick={addItem}
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-emerald-400"
            >
              置く
            </button>
          </div>
        </section>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-neutral-300">触れたログ</h2>
            <span className="text-xs text-neutral-500">過去12週</span>
          </div>
          <div className="flex gap-6 text-xs">
            <div>
              <div className="text-2xl font-bold text-emerald-400">{streak}</div>
              <div className="text-neutral-500">連続日</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-emerald-400">{todayCount}</div>
              <div className="text-neutral-500">今日</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-emerald-400">{totalTouches}</div>
              <div className="text-neutral-500">累計</div>
            </div>
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {heatmap.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-1">
                {week.map((d) => (
                  <div
                    key={d.key}
                    title={`${d.label}: ${d.count}回`}
                    className={`h-3 w-3 rounded-sm ${heatColor(d.count, d.future)}`}
                  />
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-neutral-300">
              気になってる事（{active.length}）
            </h2>
          </div>
          {active.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              まだ何もない。気軽に置いてみよう。
            </div>
          ) : (
            <ul className="space-y-2">
              {active.map((it) => {
                const lastTouch = it.touches[it.touches.length - 1];
                const lastActivity = lastTouch ?? it.createdAt;
                const idle = daysSince(lastActivity);
                const du = daysUntil(it.deadline);
                const overdue = du !== null && du < 0;
                const soon = du !== null && du >= 0 && du <= 1;
                const isExpanded = expandedId === it.id;
                return (
                  <li
                    key={it.id}
                    className="rounded-md border border-neutral-800 bg-neutral-900"
                  >
                    <div className="flex items-center gap-3 px-3 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-sm">{it.title}</div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                          {touchDots(it.touches.length)}
                          {idle >= 3 && (
                            <span className="text-amber-400">{idle}日触ってない</span>
                          )}
                          {it.importance && (
                            <span className="rounded-sm bg-neutral-800 px-1 text-[10px]">
                              重要度{" "}
                              {it.importance === 3
                                ? "高"
                                : it.importance === 2
                                  ? "中"
                                  : "低"}
                            </span>
                          )}
                          {it.deadline && (
                            <span
                              className={
                                overdue
                                  ? "text-red-400"
                                  : soon
                                    ? "text-amber-400"
                                    : ""
                              }
                            >
                              ～{it.deadline}
                              {overdue
                                ? `（${-du!}日超過）`
                                : du === 0
                                  ? "（今日）"
                                  : du === 1
                                    ? "（明日）"
                                    : ""}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => fetchBreakdown(it.id, it.title)}
                        className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 shrink-0"
                      >
                        1分だけ
                      </button>
                      <button
                        onClick={() => touchItem(it.id)}
                        className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 shrink-0"
                      >
                        触った
                      </button>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : it.id)}
                        className="text-neutral-500 hover:text-neutral-200 px-1 text-lg leading-none"
                        aria-label="詳細"
                      >
                        ⋯
                      </button>
                    </div>
                    {it.miniStep && (
                      <div className="border-t border-sky-500/20 bg-sky-500/5 px-3 py-2 flex items-center gap-2 text-xs">
                        <span className="flex-1 min-w-0 text-sky-200">
                          🪜 {it.miniStep}
                        </span>
                        <button
                          onClick={() => doneMiniStep(it.id)}
                          className="rounded-md bg-emerald-500 px-2.5 py-1 font-semibold text-neutral-950 hover:bg-emerald-400 shrink-0"
                        >
                          やった
                        </button>
                        <button
                          onClick={() => clearMiniStep(it.id)}
                          className="text-neutral-500 hover:text-neutral-300 shrink-0"
                        >
                          外す
                        </button>
                      </div>
                    )}
                    {breakdownId === it.id && (
                      <div className="border-t border-neutral-800 px-3 py-3 space-y-2 text-xs">
                        <div className="text-neutral-400">
                          最初の1分でやるなら…
                        </div>
                        {breakdownLoading ? (
                          <div className="text-neutral-500 animate-pulse">
                            AIが一歩を考え中…
                          </div>
                        ) : breakdownSteps.length === 0 ? (
                          <div className="text-neutral-500">
                            取得に失敗。もう一度「1分だけ」を押してみて。
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {breakdownSteps.map((step, i) => (
                              <button
                                key={i}
                                onClick={() => pickMiniStep(it.id, step)}
                                className="block w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-left text-neutral-200 hover:border-sky-500 hover:text-sky-200"
                              >
                                {step}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {isExpanded && (
                      <div className="border-t border-neutral-800 px-3 py-3 space-y-3 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-neutral-500">重要度:</span>
                          {([undefined, 1, 2, 3] as const).map((v) => (
                            <button
                              key={String(v)}
                              onClick={() => setImportance(it.id, v)}
                              className={`rounded-sm border px-2 py-0.5 ${
                                it.importance === v
                                  ? "border-emerald-500 text-emerald-300"
                                  : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
                              }`}
                            >
                              {v === undefined
                                ? "なし"
                                : v === 3
                                  ? "高"
                                  : v === 2
                                    ? "中"
                                    : "低"}
                            </button>
                          ))}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-neutral-500">期限:</span>
                          <input
                            type="date"
                            value={it.deadline ?? ""}
                            onChange={(e) =>
                              setDeadline(it.id, e.target.value || undefined)
                            }
                            className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
                          />
                          {it.deadline && (
                            <button
                              onClick={() => setDeadline(it.id, undefined)}
                              className="text-neutral-500 hover:text-neutral-200"
                            >
                              消す
                            </button>
                          )}
                        </div>
                        <div className="flex justify-between pt-1">
                          <span className="text-neutral-600">
                            置いたのは{daysSince(it.createdAt)}日前
                          </span>
                          <button
                            onClick={() => letGo(it.id)}
                            className="text-neutral-400 hover:text-amber-300"
                          >
                            手放す
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {letGoList.length > 0 && (
          <section className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
            <button
              onClick={() => setShowLetGo((v) => !v)}
              className="flex w-full items-center justify-between text-sm text-neutral-400 hover:text-neutral-200"
            >
              <span>手放したもの（{letGoList.length}）</span>
              <span className="text-xs">{showLetGo ? "閉じる" : "開く"}</span>
            </button>
            {showLetGo && (
              <ul className="mt-3 space-y-1 text-xs">
                {letGoList.map((it) => (
                  <li
                    key={it.id}
                    className="flex items-center justify-between gap-2 text-neutral-500"
                  >
                    <span className="truncate">{it.title}</span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="text-neutral-600">
                        {daysSince(it.letGoAt ?? Date.now())}日前
                      </span>
                      <button
                        onClick={() => restore(it.id)}
                        className="text-neutral-400 hover:text-emerald-300"
                      >
                        戻す
                      </button>
                      <button
                        onClick={() => removeForever(it.id)}
                        className="text-neutral-600 hover:text-red-400"
                      >
                        消す
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <footer className="pt-4 text-center text-xs text-neutral-600">
          TaskLog v3 — 触れたら積み上がる
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
