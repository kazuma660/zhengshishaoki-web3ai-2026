"use client";

import { useEffect, useMemo, useState } from "react";

type Task = {
  id: string;
  title: string;
  importance: 1 | 2 | 3;
  deadline?: string;
  createdAt: number;
};

type DoneLog = {
  id: string;
  title: string;
  completedAt: number;
};

const STORAGE_TASKS = "tasklog:tasks";
const STORAGE_DONE = "tasklog:done";

function todayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function daysUntil(deadline?: string): number {
  if (!deadline) return 9999;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const d = new Date(deadline);
  d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

function priorityScore(t: Task): number {
  const importanceWeight = t.importance * 10;
  const du = daysUntil(t.deadline);
  const urgencyWeight =
    du <= 0 ? 50 : du <= 1 ? 30 : du <= 3 ? 15 : du <= 7 ? 5 : 0;
  return importanceWeight + urgencyWeight;
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [done, setDone] = useState<DoneLog[]>([]);
  const [title, setTitle] = useState("");
  const [importance, setImportance] = useState<1 | 2 | 3>(2);
  const [deadline, setDeadline] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const t = localStorage.getItem(STORAGE_TASKS);
      const d = localStorage.getItem(STORAGE_DONE);
      if (t) setTasks(JSON.parse(t));
      if (d) setDone(JSON.parse(d));
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_TASKS, JSON.stringify(tasks));
  }, [tasks, hydrated]);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_DONE, JSON.stringify(done));
  }, [done, hydrated]);

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => priorityScore(b) - priorityScore(a)),
    [tasks]
  );

  function addTask() {
    if (!title.trim()) return;
    setTasks((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        title: title.trim(),
        importance,
        deadline: deadline || undefined,
        createdAt: Date.now(),
      },
    ]);
    setTitle("");
    setDeadline("");
    setImportance(2);
  }

  function completeTask(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    setDone((prev) => [
      ...prev,
      { id: t.id, title: t.title, completedAt: Date.now() },
    ]);
    setTasks((prev) => prev.filter((x) => x.id !== id));
  }

  function deleteTask(id: string) {
    setTasks((prev) => prev.filter((x) => x.id !== id));
  }

  const doneByDay = useMemo(() => {
    const map = new Map<string, number>();
    done.forEach((d) => {
      const k = todayKey(d.completedAt);
      map.set(k, (map.get(k) ?? 0) + 1);
    });
    return map;
  }, [done]);

  const last30 = useMemo(() => {
    const arr: { key: string; label: string; count: number }[] = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const k = todayKey(d.getTime());
      arr.push({
        key: k,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        count: doneByDay.get(k) ?? 0,
      });
    }
    return arr;
  }, [doneByDay]);

  const streak = useMemo(() => {
    let s = 0;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    for (let i = 0; i < 365; i++) {
      const d = new Date(now.getTime() - i * 86400000);
      const k = todayKey(d.getTime());
      if ((doneByDay.get(k) ?? 0) > 0) s++;
      else break;
    }
    return s;
  }, [doneByDay]);

  const totalDone = done.length;
  const todayDone = doneByDay.get(todayKey(Date.now())) ?? 0;

  function heatColor(count: number): string {
    if (count === 0) return "bg-neutral-800";
    if (count === 1) return "bg-emerald-900";
    if (count === 2) return "bg-emerald-700";
    if (count <= 4) return "bg-emerald-500";
    return "bg-emerald-300";
  }

  return (
    <main className="flex-1 bg-neutral-950 text-neutral-100 px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-3xl space-y-8">
        <header className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">
            TaskLog <span className="text-emerald-400">v1</span>
          </h1>
          <p className="text-sm text-neutral-400">
            タスク作っても結局やらない人のための、達成が積み重なるタスク管理
          </p>
        </header>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-neutral-300">タスクを追加</h2>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTask()}
              placeholder="何をやる？（1分でできる小さなことでOK）"
              className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-emerald-500"
            />
            <select
              value={importance}
              onChange={(e) =>
                setImportance(Number(e.target.value) as 1 | 2 | 3)
              }
              className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-2 text-sm"
            >
              <option value={1}>低</option>
              <option value={2}>中</option>
              <option value={3}>高</option>
            </select>
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-950 px-2 py-2 text-sm"
            />
            <button
              onClick={addTask}
              className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-emerald-400"
            >
              追加
            </button>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-neutral-300">
              優先順位順タスク
            </h2>
            <span className="text-xs text-neutral-500">
              重要度 × 期限の近さで自動ソート
            </span>
          </div>
          {sortedTasks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
              タスクなし。1分でできることから書いてみよう。
            </div>
          ) : (
            <ul className="space-y-2">
              {sortedTasks.map((t) => {
                const du = daysUntil(t.deadline);
                const overdue = t.deadline && du < 0;
                const soon = t.deadline && du >= 0 && du <= 1;
                return (
                  <li
                    key={t.id}
                    className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2"
                  >
                    <button
                      onClick={() => completeTask(t.id)}
                      className="h-5 w-5 shrink-0 rounded-full border-2 border-neutral-600 hover:border-emerald-400 hover:bg-emerald-500/20"
                      aria-label="完了"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm">{t.title}</div>
                      <div className="flex gap-2 text-xs text-neutral-500">
                        <span>
                          重要度:{" "}
                          {t.importance === 3
                            ? "高"
                            : t.importance === 2
                              ? "中"
                              : "低"}
                        </span>
                        {t.deadline && (
                          <span
                            className={
                              overdue
                                ? "text-red-400"
                                : soon
                                  ? "text-amber-400"
                                  : ""
                            }
                          >
                            期限: {t.deadline}
                            {overdue
                              ? `（${-du}日超過）`
                              : soon
                                ? du === 0
                                  ? "（今日）"
                                  : "（明日）"
                                : ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteTask(t.id)}
                      className="text-xs text-neutral-500 hover:text-red-400"
                    >
                      削除
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-neutral-300">達成ログ</h2>
            <span className="text-xs text-neutral-500">過去30日</span>
          </div>
          <div className="flex gap-4 text-xs">
            <div>
              <div className="text-2xl font-bold text-emerald-400">{streak}</div>
              <div className="text-neutral-500">連続達成日</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-emerald-400">
                {todayDone}
              </div>
              <div className="text-neutral-500">今日の達成</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-emerald-400">
                {totalDone}
              </div>
              <div className="text-neutral-500">累計</div>
            </div>
          </div>
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: "repeat(30, minmax(0, 1fr))" }}
          >
            {last30.map((d) => (
              <div
                key={d.key}
                title={`${d.label}: ${d.count}件`}
                className={`aspect-square rounded-sm ${heatColor(d.count)}`}
              />
            ))}
          </div>
          {done.length > 0 && (
            <details className="text-xs text-neutral-400">
              <summary className="cursor-pointer hover:text-neutral-200">
                完了したタスク一覧（{done.length}件）
              </summary>
              <ul className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                {[...done]
                  .sort((a, b) => b.completedAt - a.completedAt)
                  .map((d, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span className="truncate">{d.title}</span>
                      <span className="text-neutral-600 shrink-0">
                        {todayKey(d.completedAt)}
                      </span>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </section>

        <footer className="pt-4 text-center text-xs text-neutral-600">
          TaskLog v1 — VPC 第5回プロトタイプ
        </footer>
      </div>
    </main>
  );
}
