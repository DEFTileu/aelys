import { Fragment } from 'react'
import { PageSkeleton } from '../../components/PageSkeleton'
import { AelysMark } from '../../components/AelysMark'
import { ModelPicker } from '../../components/ModelPicker'
import { MarkdownContent } from '../../components/MarkdownContent'
import { ArrowLeft, ArrowUp, CircleAlert, Eye, Lock, MessageSquareText, Paperclip, Pin, Repeat, RotateCcw, Search, Square, SquarePen, Zap } from '../../icons'
import { EFFORT_SHORT, modelName, providerLabel, supportsThinking, type Effort } from '../../data/aiModels'
import { navigate } from '../../lib/router'
import type { ApiStatus } from '../../types'
import { AnswerActions, FileChip, RunSteps, SourceRows, SourcesPopover, Tile } from './ChatParts'
import { ACCEPTED_FILES, chatTone, clock, formatTokens, formatWindow, savedSteps, sourceChip, sourceSummary, whenLabel } from './chatModel'
import { LIVE, SUGGESTIONS, SourceList, useAi } from './useAi'
import '../desktop/page-tokens.css'
import './ai-chat.css'

export function AiDesktop({ apiStatus }: { apiStatus: ApiStatus }) {
  const { root, historyOpen, setHistoryOpen, search, setSearch, running, recovering, checkRun, creationUncertain, retryCreation, forgetRecovery, storageReady, newChat, groups, conversationId, loading, openChat, togglePin, selectedTitle, allProviders, active, applyChoice, isDefault, toggleDefault, scroller, pinned, shown, extras, feedback, lastAssistant, actionCards, unanchored, card, providerId, regenerate, rate, dividers, partial, live, liveSteps, actions, outcome, lastUser, execute, fastest, owner, providers, sharing, ask, sources, knowledgeScope, setKnowledgeScope, setConversationId, setLines, setSources, notice, submit, files, removeFile, pasteFiles, focused, setFocused, field, message, setMessage, draftRows, canSend, cancel, picker, attach, sourcesOpen, setSourcesOpen, toggleSource, costLabel, usedTokens, windowTokens, percent, activeProvider } = useAi(apiStatus, false)
  return <div ref={root} className={`actual-ai${historyOpen ? ' actual-ai--history-open' : ''}`}>
    <aside className="actual-ai__history" aria-label="Conversations">
      <div className="actual-ai__history-search">
        <label className="actual-ai__search"><Search size={16} /><input aria-label="Search conversations" placeholder="Search chats" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      <button type="button" className="actual-ai__new" disabled={running || creationUncertain || recovering} onClick={newChat}><SquarePen size={16} />New chat<kbd>⌘N</kbd></button>
      <div className="actual-ai__list" aria-label="Conversation list">
        {groups.map((group) => <Fragment key={group.title}>
          <p className="actual-ai__list-label">{group.title}</p>
          {group.items.map((item) => {
            const tone = chatTone(item.title); const when = whenLabel(item); const selected = item.id === conversationId
            return <div key={item.id} className={`actual-ai__conversation${selected ? ' actual-ai__conversation--selected' : ''}`}>
              <button type="button" className="actual-ai__conversation-main" disabled={running || loading} aria-current={selected ? 'true' : undefined} onClick={() => openChat(item)}>
                <Tile tone={tone} size={15} />
                <span className="actual-ai__conversation-body">
                  <span className="actual-ai__conversation-top"><b>{item.title || 'Untitled conversation'}</b>{running && selected && <i className="actual-ai__live" aria-label="Running" />}{when && <time dateTime={item.updated_at}>{when}</time>}</span>
                  {item.preview && <span className="actual-ai__conversation-preview">{item.preview}</span>}
                </span>
              </button>
              <button type="button" className="actual-ai__pin" aria-label={item.pinned ? `Unpin ${item.title || 'chat'}` : `Pin ${item.title || 'chat'}`} title={item.pinned ? 'Unpin' : 'Pin'} aria-pressed={!!item.pinned} onClick={() => void togglePin(item)}><Pin size={14} /></button>
            </div>
          })}
        </Fragment>)}
        {!groups.length && <p className="actual-ai__empty-list">{search.trim() ? <>No chats match “{search.trim()}”</> : 'No conversations yet.'}</p>}
      </div>
    </aside>

    <section className="actual-ai__thread" aria-label="AI conversation">
      <div className="actual-ai__thread-head">
        <div className="actual-ai__head-main"><h2>{selectedTitle}</h2>
          <ModelPicker providers={allProviders} value={active} onChange={applyChoice} disabled={running} showEffort isDefault={isDefault} onToggleDefault={toggleDefault} /></div>
      </div>
      <div className="actual-ai__lines" ref={scroller} aria-live="polite" onScroll={(event) => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}>
        {shown.map((line) => {
          const extra = extras[line.id]
          return <Fragment key={line.id}>
            {line.role === 'user'
              ? <article className="actual-ai__line actual-ai__line--user">
                {line.attachments?.map((file) => <FileChip key={file.name} name={file.name} size={file.size} />)}
                <div className="actual-ai__bubble">{line.content}</div>
                {line.created_at && !Number.isNaN(Date.parse(line.created_at)) && <time dateTime={line.created_at}>{clock(line.created_at)}</time>}
              </article>
              : <article className="actual-ai__line">
                <AelysMark size={30} />
                <div className="actual-ai__answer">
                  {(extra?.steps.length || line.steps?.length) ? <RunSteps steps={extra?.steps ?? savedSteps(line.steps)} live={false} /> : null}
                  <div className="actual-ai__bubble"><MarkdownContent text={line.content} />{line.source_refs_json?.length ? <SourceList sources={line.source_refs_json} /> : null}</div>
                  {actionCards(line.id)}{line === lastAssistant && unanchored.map(card)}
                  {line.role === 'assistant' && <AnswerActions text={line.content} {...(extra?.meta ? { meta: extra.meta } : {})} feedback={feedback[line.id] ?? line.feedback ?? null} canRegenerate={line === lastAssistant} regenDisabled={running || loading || !providerId} canRate={!line.id.startsWith('stopped-')} onRegenerate={regenerate} onFeedback={(next) => void rate(line, next)} />}
                </div>
              </article>}
            {dividers.filter((item) => item.chat === conversationId && item.after === line.id).map((item) => <div key={item.text + item.after} className="actual-ai__divider"><span /><Repeat size={12} />{item.text}<span /></div>)}
          </Fragment>
        })}
        {(partial || (live && (liveSteps.length > 0 || actions.some((item) => item.anchor === LIVE)))) && <article className="actual-ai__line">
          <AelysMark size={30} />
          <div className="actual-ai__answer">
            <RunSteps steps={liveSteps} live />
            {partial && <div className={`actual-ai__bubble${live ? ' actual-ai__bubble--streaming' : ''}`}><MarkdownContent text={partial} /></div>}
            {actionCards(LIVE)}
          </div>
        </article>}
        {live && !partial && !liveSteps.length && <article className="actual-ai__line"><AelysMark size={30} /><div className="actual-ai__answer"><span className="actual-ai__dots" role="status" aria-label="Aelys is thinking"><i /><i /><i /></span></div></article>}
        {outcome?.status === 'stopped' && <p className="actual-ai__stopped"><Square size={12} />{lastAssistant && shown[shown.length - 1] === lastAssistant ? 'Stopped' : 'Stopped before answering'}</p>}
        {outcome?.status === 'error' && <div className="actual-ai__error" role="alert"><div className="actual-ai__error-head"><CircleAlert size={18} /><div><b>{outcome.message}</b><span>{outcome.code} · Nothing was lost. You can retry or ask a different model.</span></div></div>
          <div className="actual-ai__error-actions"><button type="button" disabled={running} onClick={() => void execute(outcome.prompt, { after: lastUser ? [lastUser.id] : [] })}><RotateCcw size={15} />Retry</button>
            {fastest && <button type="button" disabled={running} onClick={() => void execute(outcome.prompt, { after: lastUser ? [lastUser.id] : [] }, { providerId: fastest.provider.id, model: fastest.model.id })}><Zap size={15} />Try {fastest.model.name}</button>}</div></div>}
        {loading && !shown.length && !partial && <PageSkeleton kind="chat" compact label="conversation" />}
        {!loading && !shown.length && !partial && !running && <div className="actual-ai__welcome"><AelysMark size={56} /><h2>What can I help with{owner.name ? `, ${owner.name.split(' ')[0]}` : ''}?</h2>
          <p>{providers.length ? `I can see ${sourceSummary(sharing)}. Ask anything, or start from one of these.` : 'Add a provider in Settings › AI & models to start a conversation.'}</p>
          {providers.length > 0 && <div className="actual-ai__suggestions">{SUGGESTIONS.map((item) => <button type="button" key={item.title} onClick={() => ask(item.prompt)}><Tile tone={item} size={17} /><span><b>{item.title}</b><span>{item.hint}</span></span></button>)}</div>}</div>}
      </div>
      {sources.length > 0 && running && <SourceList sources={sources} />}
      {knowledgeScope && <p className="actual-ai__notice">Knowledge question · {knowledgeScope.note_ids?.length ? 'selected document' : knowledgeScope.project_id ? 'selected project' : 'enabled library'} · excerpts go to the selected provider <button type="button" disabled={running} onClick={() => { setKnowledgeScope(undefined); setConversationId(''); setLines([]); setSources([]) }}>Clear sources</button></p>}
      {!storageReady && <p className="actual-ai__notice" role="status">Opening local recovery storage…</p>}
      {creationUncertain && <div className="actual-ai__notice" role="status"><button type="button" disabled={running} onClick={() => void retryCreation()}>Retry same request</button><button type="button" disabled={running} onClick={() => void forgetRecovery()}>Forget recovery record</button></div>}
      {recovering && <div className="actual-ai__notice" role="status"><button type="button" disabled={running} onClick={() => void checkRun()}>Check run status</button><button type="button" disabled={running} onClick={() => void forgetRecovery()}>Forget recovery record</button></div>}
      {notice && <p className="actual-ai__notice" role="status">{notice}</p>}
      <form className="actual-ai__compose" onSubmit={submit}>
        {files.length > 0 && <div className="actual-ai__files">{files.map((item) => <FileChip key={item.key} name={item.name} size={item.size} pending={!item.id} onRemove={() => removeFile(item)} />)}</div>}
        <div className={`actual-ai__compose-field${focused ? ' actual-ai__compose-field--focus' : ''}`}>
          <textarea ref={field} aria-label="Message Aelys" value={message} rows={draftRows} disabled={loading || !storageReady || creationUncertain || recovering}
            onChange={(event) => setMessage(event.target.value)} onPaste={pasteFiles} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
              if (event.key === 'Escape' && running) { event.preventDefault(); void cancel() }
            }}
            placeholder={running ? 'Aelys is answering… you can type the next message' : 'Message Aelys. Ask, plan or give a task'} />
          <div className="actual-ai__compose-row">
            <input ref={picker} type="file" hidden multiple accept={ACCEPTED_FILES.map((item) => `.${item}`).join(',')} aria-label="Attach files" onChange={(event) => void attach(event.target.files)} />
            <button type="button" className="actual-ai__icon" aria-label="Attach a file" title="Attach a file" onClick={() => picker.current?.click()}><Paperclip size={17} /></button>
            <span className="actual-ai__src-wrap">
              <button type="button" className="actual-ai__chip" title="What Aelys can see" aria-haspopup="dialog" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen(!sourcesOpen)}><Eye size={14} />{knowledgeScope && sources.length ? `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}` : sourceChip(sharing.size)}</button>
              {sourcesOpen && <SourcesPopover on={sharing} onToggle={(id, next) => void toggleSource(id, next)} onClose={() => setSourcesOpen(false)} />}
            </span>
            <span className="actual-ai__spacer" />
            {focused && !running && <span className="actual-ai__hint">↵ send · ⇧↵ new line</span>}
            {running
              ? <button type="button" className="actual-ai__stop" aria-label="Stop generating" title="Stop (Esc)" onClick={() => void cancel()}><i /></button>
              : <button className="actual-ai__send" type="submit" aria-label="Send message" disabled={!canSend}><ArrowUp size={18} /></button>}
          </div>
        </div>
      </form>
    </section>

    <aside className="actual-ai__side" aria-label="Chat resources">
      <section className="actual-ai__card"><h2>What Aelys can see</h2><p className="actual-ai__side-copy">In this chat only. Aelys reads, it never changes data without asking.</p>
        <SourceRows on={sharing} onToggle={(id, next) => void toggleSource(id, next)} />
        {knowledgeScope && <p className="actual-ai__side-copy actual-ai__side-scope">{knowledgeScope.note_ids?.length ? 'Selected document' : knowledgeScope.project_id ? 'Selected project' : 'Enabled library'}{sources.length > 0 ? ` · ${sources.length} ${sources.length === 1 ? 'source' : 'sources'} retrieved` : ''}</p>}</section>
      <section className="actual-ai__card actual-ai__chatinfo"><h2><span>This chat</span><span className="actual-ai__cost">{costLabel}</span></h2>
        <p className="actual-ai__used"><b>{formatTokens(usedTokens)}</b><span>of {formatWindow(windowTokens)} context</span></p>
        <div className="actual-ai__bar" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><i style={{ width: `${percent}%` }} /></div>
        <dl><div><dt>Model</dt><dd>{activeProvider ? (active.model === 'auto' ? 'Auto' : `${providerLabel(activeProvider.kind)} ${modelName(activeProvider, active.model)}`) : 'None'}</dd></div>
          {supportsThinking(activeProvider, active.model) && active.effort && active.effort !== 'off' && <div><dt>Reasoning</dt><dd>{EFFORT_SHORT[active.effort as Effort]}</dd></div>}
          <div><dt>Messages</dt><dd>{shown.length}</dd></div></dl></section>
      <p className="actual-ai__privacy"><Lock size={14} aria-hidden="true" />Messages go to the provider you pick. Keys stay on your Aelys backend.</p>
    </aside>
  </div>
}
