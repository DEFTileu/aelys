import { Fragment, useState } from 'react'
import { askAelys, toggleTask, useDesktopState } from '../../lib/desktopStore'
import { navigate } from '../../lib/router'
import {
  AlarmClock,
  Calendar,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Flag,
  Folder,
  GraduationCap,
  House,
  ListChecks,
  ListFilter,
  Sparkles,
  Sprout,
  User,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { ScreenToolbar, SegmentedTabs } from '../../components/ScreenToolbar'
import {
  TASK_FILTERS,
  TASK_PROJECTS,
  TASK_STATS,
  TASK_TAGS,
  TASK_TOTAL,
  TODAY_TASKS,
  UPCOMING_GROUPS,
  type TaskIcon,
  type TaskTag,
} from '../../data/desktop/tasks'
import './tasks.css'

const ICONS: Record<TaskIcon, LucideIcon> = {
  calendar: Calendar,
  'calendar-days': CalendarDays,
  folder: Folder,
  'list-filter': ListFilter,
  sparkles: Sparkles,
  house: House,
  'graduation-cap': GraduationCap,
  wallet: Wallet,
  sprout: Sprout,
  'list-checks': ListChecks,
  'alarm-clock': AlarmClock,
  flag: Flag,
  user: User,
  check: Check,
}

type TaskTab = 'today' | 'plan' | 'projects' | 'filters'

const TASK_TABS: { id: TaskTab; label: string; icon: LucideIcon }[] = [
  { id: 'today', label: 'Today', icon: Calendar },
  { id: 'plan', label: 'Plan', icon: CalendarDays },
  { id: 'projects', label: 'Projects', icon: Folder },
  { id: 'filters', label: 'Filters', icon: ListFilter },
]

function TagPill({ tag }: { tag: TaskTag }) {
  const Icon = ICONS[tag.icon]
  return (
    <span className="tasks-tag" style={{ background: tag.soft, color: tag.ink }}>
      <Icon size={12} />
      {tag.t}
    </span>
  )
}

function LegendRow({ color, label, value, valueColor }: { color: string; label: string; value: number; valueColor?: string }) {
  return (
    <div className="tasks-legend__row">
      <span className="tasks-legend__dot" style={{ background: color }} />
      <span className="tasks-legend__label">{label}</span>
      <b className="tasks-legend__value" style={{ color: valueColor }}>{value}</b>
    </div>
  )
}

export function TasksScreen() {
  const [tab, setTab] = useState<TaskTab>('today')
  // Today's done state is shared with the Home Today widget; the first two tasks start completed.
  const { done } = useDesktopState()
  const toggle = toggleTask

  const doneCount = done.filter(Boolean).length
  const completed = doneCount + TASK_STATS.completedElsewhere
  const percent = Math.round((completed / TASK_TOTAL) * 100)
  const upcomingCount = UPCOMING_GROUPS.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="tasks-screen">
      <ScreenToolbar
        placeholder="Ask Aelys about your tasks…"
        primary="New task"
        onAsk={askAelys}
        tabs={<SegmentedTabs tabs={TASK_TABS} value={tab} onChange={setTab} label="Task views" />}
      />

      <div className="tasks-grid">
        <div className="tasks-col">
          <section className="tasks-card" data-glass="">
            <div className="tasks-head tasks-head--today">
              <span className="tasks-heading">Today</span>
              <span className="tasks-count">{TODAY_TASKS.length}</span>
              <span className="tasks-spacer" />
              <span className="tasks-muted">Wednesday, October 28</span>
              <button type="button" className="tasks-icon-btn" aria-label="Previous day"><ChevronLeft size={16} /></button>
              <button type="button" className="tasks-icon-btn" aria-label="Next day"><ChevronRight size={16} /></button>
            </div>
            {TODAY_TASKS.map((task, i) => {
              const on = done[i]
              return (
                <div key={task.title} className="tasks-row">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    aria-label={task.title}
                    className="tasks-check"
                    style={{ border: on ? 'none' : '2px solid #BDB7C2', background: on ? '#6A4CF2' : 'transparent' }}
                    onClick={() => toggle(i)}
                  >
                    {on && <Check size={13} />}
                  </button>
                  <span className="tasks-flag" role="img" title={task.priority} aria-label={`${task.priority} priority`} style={{ color: task.flag }}>
                    <Flag size={16} />
                  </span>
                  <div className="tasks-main">
                    <div className="tasks-line">
                      <span className="tasks-name" style={{ color: on ? '#625D69' : '#1C1B22' }}>{task.title}</span>
                      <TagPill tag={TASK_TAGS[task.tag]} />
                    </div>
                    <div className="tasks-desc">{task.description}</div>
                  </div>
                  <span className="tasks-time">{task.time}</span>
                  <button type="button" className="tasks-more" title="More" aria-label={`More options for ${task.title}`}><Ellipsis size={16} /></button>
                </div>
              )
            })}
          </section>

          <section className="tasks-card" data-glass="">
            <div className="tasks-head tasks-head--upcoming">
              <span className="tasks-heading">Upcoming</span>
              <span className="tasks-count">{upcomingCount}</span>
              <span className="tasks-spacer" />
              <span className="tasks-muted">All</span>
            </div>
            {UPCOMING_GROUPS.map(group => (
              <Fragment key={group.day}>
                <div className="tasks-day">
                  <b className="tasks-day__name">{group.day}</b>
                  <span className="tasks-day__sub">{group.sub}</span>
                </div>
                {group.items.map(item => (
                  <div key={item.title} className="tasks-upcoming">
                    <span className="tasks-ring" aria-hidden="true" />
                    <span className="tasks-flag" style={{ color: item.flag }} aria-hidden="true"><Flag size={16} /></span>
                    <span className="tasks-upcoming__name">{item.title}</span>
                    <TagPill tag={TASK_TAGS[item.tag]} />
                    <span className="tasks-spacer" />
                    <span className="tasks-time">{item.time}</span>
                    <span className="tasks-dots" aria-hidden="true"><Ellipsis size={16} /></span>
                  </div>
                ))}
              </Fragment>
            ))}
          </section>
        </div>

        <div className="tasks-col">
          <section className="tasks-card" data-glass="">
            <div className="tasks-subhead tasks-subhead--block">Quick filters</div>
            <div className="tasks-filters">
              {TASK_FILTERS.map(filter => {
                const Icon = ICONS[filter.icon]
                return (
                  <button
                    key={filter.label}
                    type="button"
                    aria-pressed={!!filter.active}
                    className="tasks-filter"
                    style={{ background: filter.active ? '#EEEAFD' : '#F7F4F1' }}
                  >
                    <Icon size={16} color={filter.color} />
                    <span className="tasks-filter__label">{filter.label}</span>
                    <span
                      className="tasks-filter__count"
                      style={{ background: filter.warn ? '#FDE3E1' : 'rgba(0,0,0,.05)', color: filter.warn ? '#C9302C' : '#4F4A56' }}
                    >
                      {filter.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="tasks-card" data-glass="">
            <div className="tasks-card-head tasks-card-head--projects">
              <span className="tasks-subhead tasks-subhead--grow">Projects</span>
              <button type="button" className="tasks-link" onClick={() => navigate('/projects')}>All<ChevronRight size={16} /></button>
            </div>
            <div className="tasks-projects">
              {TASK_PROJECTS.map(project => {
                const Icon = ICONS[project.icon]
                return (
                  <div key={project.title} className="tasks-project">
                    <span className="tasks-project__icon" style={{ background: project.soft, color: project.c }}><Icon size={16} /></span>
                    <div className="tasks-project__body">
                      <div className="tasks-project__top">
                        <span className="tasks-project__name">{project.title}</span>
                        <span className="tasks-project__pct">{project.pct}%</span>
                      </div>
                      <div className="tasks-bar">
                        <div className="tasks-bar__fill" style={{ width: `${project.pct}%`, background: project.c }} />
                      </div>
                      <div className="tasks-project__sub">{project.sub}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="tasks-card" data-glass="">
            <div className="tasks-card-head">
              <span className="tasks-subhead tasks-subhead--grow">Statistics</span>
              <button type="button" className="tasks-select">Week<ChevronDown size={14} /></button>
            </div>
            <div className="tasks-stats">
              <div className="tasks-donut" style={{ background: `conic-gradient(#6A4CF2 0 ${percent}%,#E9E3F5 ${percent}%)` }}>
                <div className="tasks-donut__inner">
                  <b className="tasks-donut__value">{completed}/{TASK_TOTAL}</b>
                  <span className="tasks-donut__label">today</span>
                </div>
              </div>
              <div className="tasks-legend">
                <LegendRow color="#1FB58A" label="Completed" value={completed} />
                <LegendRow color="#3B82F6" label="In progress" value={TASK_STATS.inProgress} />
                <LegendRow color="#E5484D" label="Overdue" value={TASK_STATS.overdue} valueColor="#C9302C" />
                <LegendRow color="#A29DA8" label="Total" value={TASK_TOTAL} />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
