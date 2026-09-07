import { useEffect, useState } from 'react';
import { api, type TaskSummary } from '../lib/api.js';
import { useApp } from '../store/app.js';

/**
 * Your level, and the tasks behind it.
 *
 * The level is public - it sits on your card, where anyone can see it. The rest
 * of this is not: the XP total and the task list are a record of what you have
 * and have not got round to, and there is deliberately nowhere to read anyone
 * else's. A leaderboard is a different product from a place your friends talk.
 */
export function LevelPanel() {
  const progress = useApp((s) => s.progress);
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api
      .listTasks()
      .then((result) => setTasks(result.tasks))
      .catch(() => setFailed(true));
    // Refetched when a task completes, so the list is right without a reopen.
  }, [progress.completedTaskIds.length]);

  const pct = progress.needed > 0 ? Math.min(100, (progress.intoLevel / progress.needed) * 100) : 0;

  const groups = new Map<string, TaskSummary[]>();
  for (const task of tasks ?? []) {
    const list = groups.get(task.group) ?? [];
    list.push(task);
    groups.set(task.group, list);
  }

  const doneCount = (tasks ?? []).filter((t) => t.done).length;

  return (
    <>
      <div className="section">
        <h3 className="section__title">Level</h3>

        <div className="level__head">
          <span className="level__number mono">{progress.level}</span>
          <div className="level__bar" role="img" aria-label={`${progress.intoLevel} of ${progress.needed} XP into level ${progress.level}`}>
            <span className="level__fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div className="level__meta mono">
          <span>
            {progress.intoLevel.toLocaleString()} / {progress.needed.toLocaleString()} to level{' '}
            {progress.level + 1}
          </span>
          <span>{progress.xp.toLocaleString()} XP total</span>
        </div>

        {progress.streak > 0 && (
          <div className="row__hint" style={{ marginTop: 8 }}>
            {progress.streak === 1
              ? 'Here today.'
              : `${progress.streak} days running.`}
          </div>
        )}
      </div>

      <div className="section">
        <h3 className="section__title">
          Tasks{tasks ? ` (${doneCount} of ${tasks.length})` : ''}
        </h3>

        {failed && <div className="notice">Could not load your tasks.</div>}
        {!tasks && !failed && <p className="empty__body">Loading…</p>}

        {tasks &&
          [...groups].map(([group, list]) => (
            <div key={group} className="tasks__group">
              <div className="tasks__group-name mono">{group}</div>
              {list.map((task) => {
                const share = task.goal > 0 ? Math.min(1, task.progress / task.goal) : 0;
                return (
                  <div key={task.id} className={`task ${task.done ? 'task--done' : ''}`}>
                    <span className="task__tick" aria-hidden="true">
                      {task.done ? '◆' : '◇'}
                    </span>
                    <div className="task__text">
                      <span className="task__name">{task.name}</span>
                      <span className="task__how">{task.how}</span>
                      {/* Only where a number means something. "Set a profile
                          picture: 0 of 1" is noise. */}
                      {!task.done && task.goal > 1 && (
                        <span className="task__progress mono">
                          {formatProgress(task)} of {formatGoal(task)}
                        </span>
                      )}
                    </div>
                    <span className="task__xp mono">{task.xp.toLocaleString()}</span>
                    {/* Only once there is something to draw. An empty track
                        across every untouched row reads as a rule between them,
                        and turns the list into a table nobody asked for. */}
                    {!task.done && share > 0 && (
                      <span className="task__track" aria-hidden="true">
                        <span className="task__track-fill" style={{ width: `${share * 100}%` }} />
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
      </div>
    </>
  );
}

/** Seconds are stored; hours are what anybody wants to read. */
function formatProgress(task: TaskSummary): string {
  if (task.id.startsWith('voice.hours')) return `${Math.floor(task.progress / 3600)}h`;
  return task.progress.toLocaleString();
}

function formatGoal(task: TaskSummary): string {
  if (task.id.startsWith('voice.hours')) return `${Math.floor(task.goal / 3600)}h`;
  return task.goal.toLocaleString();
}
