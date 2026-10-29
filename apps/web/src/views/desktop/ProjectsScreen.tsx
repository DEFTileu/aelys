import { useState } from 'react'
import { Calendar, CircleCheck } from 'lucide-react'
import { ScreenToolbar, SegmentedTabs } from '../../components/ScreenToolbar'
import { projectCards, projectStatusStyle, projectTabs, projectToolbar, type ProjectTab } from '../../data/desktop/projects'
import { askAelys } from '../../lib/desktopStore'
import './projects.css'

export function ProjectsScreen() {
  const [tab, setTab] = useState<ProjectTab>('all')
  // The demo data has no archived projects, so the Archived tab is empty.
  const visible = tab === 'all' ? projectCards : tab === 'active' ? projectCards.filter((project) => project.status === 'Active') : []

  return <div className="projects-screen">
    <ScreenToolbar
      tabs={<SegmentedTabs tabs={projectTabs} value={tab} onChange={setTab} label="Project filter" />}
      placeholder={projectToolbar.placeholder}
      primary={projectToolbar.primary}
      onAsk={askAelys}
    />
    <div className="projects-grid">
      {visible.length === 0 && <div className="projects-empty">No archived projects</div>}
      {visible.map((project) => {
        const Icon = project.icon
        const status = projectStatusStyle[project.status]
        return <div
          key={project.title}
          className="projects-card"
          role="button"
          tabIndex={0}
          aria-label={`${project.title}, ${project.pct}% complete, ${project.status}`}
        >
          <div className="projects-card__head">
            <span className="projects-card__icon" style={{ background: `${project.color}1A`, color: project.color }}>
              <Icon size={20} aria-hidden="true" />
            </span>
            <div className="projects-card__titles">
              <div className="projects-card__title">{project.title}</div>
              <div className="projects-card__subtitle">{project.subtitle}</div>
            </div>
            <span className="projects-card__status" style={{ background: status.bg, color: status.fg }}>{project.status}</span>
          </div>
          <div>
            <div className="projects-card__progress-row">
              <span className="projects-card__progress-label">Progress</span>
              <b className="projects-card__progress-value">{project.pct}%</b>
            </div>
            <div className="projects-card__bar">
              <div className="projects-card__bar-fill" style={{ width: `${project.pct}%`, background: project.color }} />
            </div>
          </div>
          <div className="projects-card__next">
            <div className="projects-card__next-label">Next up</div>
            <div className="projects-card__next-value">{project.next}</div>
          </div>
          <div className="projects-card__footer">
            <Calendar size={16} aria-hidden="true" />
            <span className="projects-card__due">{project.due}</span>
            <CircleCheck size={16} aria-hidden="true" />
            {project.done}
          </div>
        </div>
      })}
    </div>
  </div>
}
