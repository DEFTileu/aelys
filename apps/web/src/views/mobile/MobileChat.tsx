import { Calendar, ChevronRight, Plus, Sparkles } from 'lucide-react'
import { accentOf } from '../../data/desktop/home'
import { CHAT_ACTIONS, CHAT_CONTEXT, CHAT_PLAN } from '../../data/mobile'

export type SentMessage = { text: string; time: string }

const Avatar = () => <div className="m-logo" aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 10, fontSize: 16 }}>Λ</div>

function UserBubble({ text, time }: SentMessage) {
  return <div style={{ display: 'flex', justifyContent: 'flex-end', paddingLeft: 40 }}>
    <div style={{ padding: '10px 14px', borderRadius: '20px 20px 6px 20px', background: '#E3E8FD' }}>{text}<div style={{ textAlign: 'right', fontSize: 12, lineHeight: '16px', color: '#4F4A56' }}>{time}</div></div>
  </div>
}

function AelysBubble({ text, time }: { text: string; time?: string }) {
  return <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingRight: 32 }}>
    <Avatar />
    <div style={{ padding: '10px 14px', borderRadius: '20px 20px 20px 6px', background: '#fff' }}>{text}{time && <div className="m-sub">{time}</div>}</div>
  </div>
}

// The demo conversation from the design; messages sent from the composer are appended below it.
export function MobileChat({ sent, onNewChat }: { sent: SentMessage[]; onNewChat: () => void }) {
  return <>
    <div className="m-header">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="m-logo" aria-hidden="true">Λ</div>
        <span style={{ fontSize: 18, lineHeight: '26px', fontWeight: 700, flex: 1, marginLeft: 4, textShadow: '0 1px 10px rgba(20,20,45,.4)' }}>AI Chat</span>
        <button type="button" className="m-btn m-pill" onClick={onNewChat} style={{ background: 'rgba(255,255,255,.88)', color: '#1C1B22' }}><Plus size={18} aria-hidden="true" />New chat</button>
        <span className="m-avatar" aria-label="Profile" role="img" />
      </div>
      <div className="m-shadow">
        <h1 style={{ margin: '24px 0 0', fontSize: 26, lineHeight: '32px', fontWeight: 700, letterSpacing: '-.02em' }}>Hi, Tileuzhan</h1>
        <div style={{ marginTop: 6, maxWidth: 320 }}>I’ll help you plan the day, sort out tasks and focus on what matters.</div>
      </div>
    </div>

    <div className="m-card" style={{ margin: '20px 16px 0', boxShadow: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Sparkles size={18} color="#6A4CF2" aria-hidden="true" /><span className="m-card-title" style={{ flex: 1 }}>Today’s context</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 12, marginTop: 12 }}>
        {CHAT_CONTEXT.map(({ value, sub, icon: Icon, color }) => {
          const { c, soft } = accentOf(color)
          return <div key={value} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span className="m-tile" style={{ width: 36, height: 36, borderRadius: 10, background: soft, color: c }}><Icon size={16} aria-hidden="true" /></span>
            <div style={{ minWidth: 0 }}><div style={{ lineHeight: '20px', fontWeight: 600 }}>{value}</div><div className="m-sub">{sub}</div></div>
          </div>
        })}
      </div>
    </div>

    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 16px 0' }}>
      <UserBubble text="Hi! Help me plan today. I need to prepare the BYTAN deck, run a team call, work out and pay the internet bill." time="09:12" />
      <AelysBubble text="Sure! Here’s an optimal plan based on your tasks, calendar and focus time." time="09:13" />
      <div style={{ padding: 16, borderRadius: 22, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}><Calendar size={18} color="#2F6FE4" aria-hidden="true" /><span className="m-card-title" style={{ flex: 1 }}>Plan for today</span></div>
        {CHAT_PLAN.map(({ range, title, color, tag }) => {
          const { c, soft } = accentOf(color)
          return <div key={range} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, borderTop: '1px solid #F0EBE7' }}>
            <span style={{ width: 8, height: 8, flex: 'none', borderRadius: '50%', background: c }} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ lineHeight: '20px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div><div className="m-sub">{range}</div></div>
            {tag && <span style={{ height: 24, lineHeight: '24px', padding: '0 10px', borderRadius: 12, fontSize: 13, background: soft, color: c }}>{tag}</span>}
          </div>
        })}
      </div>
      <AelysBubble text="I also found useful BYTAN materials in your notes. Want to see them?" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {CHAT_ACTIONS.map(({ title, sub, icon: Icon, color, bg }) => <div key={title} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 48, padding: '8px 12px', borderRadius: 16, background: bg }}>
          <span className="m-tile" style={{ width: 36, height: 36, borderRadius: 10, background: '#fff', color }}><Icon size={16} aria-hidden="true" /></span>
          <div style={{ flex: 1, minWidth: 0 }}><div style={{ lineHeight: '20px', fontWeight: 600 }}>{title}</div><div style={{ fontSize: 12, lineHeight: '16px', color: '#4F4A56' }}>{sub}</div></div>
          <ChevronRight size={18} color="#4F4A56" aria-hidden="true" />
        </div>)}
      </div>
      {sent.map((message, i) => <UserBubble key={i} {...message} />)}
    </div>
  </>
}
