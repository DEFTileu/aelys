import { useEffect,useRef,useState,type KeyboardEvent,type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'

const EXTENSIONS:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}

export function TelegramMediaPreview({messageId,version,kind,emoji,animated}:{messageId:string;version:number;kind:'photo'|'voice'|'audio'|'sticker';emoji?:string|null;animated?:boolean}) {
  const [url,setUrl]=useState<string>()
  const [mime,setMime]=useState('')
  const [open,setOpen]=useState(false)
  // Fitted size is measured on zoom-in and doubled, so 2x is exact for any aspect ratio.
  const [zoom,setZoom]=useState<{w:number;h:number}|null>(null)
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const generation=useRef(0)
  const currentUrl=useRef<string|undefined>(undefined)
  const controller=useRef<AbortController|undefined>(undefined)
  const working=useRef(false)
  const opener=useRef<HTMLButtonElement>(null)
  const closer=useRef<HTMLButtonElement>(null)
  const dialog=useRef<HTMLDivElement>(null)
  const image=useRef<HTMLImageElement>(null)
  useEffect(()=>{
    setUrl(undefined);setMime('');setOpen(false);setZoom(null);setLoading(false);setError('');working.current=false
    return ()=>{generation.current+=1;controller.current?.abort();if(currentUrl.current){URL.revokeObjectURL(currentUrl.current);currentUrl.current=undefined}}
  },[messageId,version])
  useEffect(()=>{if(open)closer.current?.focus()},[open])
  const load=async()=>{
    if(working.current)return
    working.current=true;setLoading(true);setError('')
    const request=++generation.current
    controller.current=new AbortController()
    try {
      const blob=await getSharedApiClient().telegramMessageMedia(messageId,{signal:controller.current.signal})
      if(request!==generation.current)return
      const expected=kind==='voice'||kind==='audio'?'audio/':'image/'
      if(!blob.type.startsWith(expected))throw new Error('Unexpected media type')
      if(currentUrl.current)URL.revokeObjectURL(currentUrl.current)
      currentUrl.current=URL.createObjectURL(blob);setUrl(currentUrl.current);setMime(blob.type)
    } catch(cause){
      if(request!==generation.current)return
      setError(cause instanceof ApiError && cause.code==='TELEGRAM_MEDIA_TOO_LARGE'?'This file is too large to preview. Open it in Telegram.':'Could not load this media. Try again or open it in Telegram.')
    } finally {if(request===generation.current){working.current=false;setLoading(false)}}
  }
  const failed=()=>setError('This media format could not be played or displayed. Open it in Telegram.')
  const save=()=>{
    if(!url)return
    const link=document.createElement('a')
    link.href=url
    link.download=`telegram-${kind==='sticker'?'sticker':'photo'}-${messageId}.${EXTENSIONS[mime]??'bin'}`
    link.click()
  }
  const close=()=>{setOpen(false);setZoom(null);opener.current?.focus()}
  const toggleZoom=()=>{
    if(zoom){setZoom(null);return}
    const box=image.current!.getBoundingClientRect()
    setZoom({w:box.width*2,h:box.height*2})
  }
  // Backdrop clicks close the dialog; clicks inside it never reach ancestors (it is portaled to body).
  const dismiss=(event:MouseEvent)=>{event.stopPropagation();if(event.target===event.currentTarget)close()}
  const onDialogKey=(event:KeyboardEvent)=>{
    event.stopPropagation()
    if(event.key==='Escape'){event.preventDefault();close();return}
    if(event.key!=='Tab')return
    const stops=[...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    const index=stops.indexOf(document.activeElement as HTMLElement)
    if(event.shiftKey&&index<=0){event.preventDefault();stops[stops.length-1].focus()}
    else if(!event.shiftKey&&(index===-1||index===stops.length-1)){event.preventDefault();stops[0].focus()}
  }
  // Animated and video stickers are not previewed; their emoji stands in for them.
  if(kind==='sticker'&&animated)return <div className="msg__media"><span className="msg__sticker" role="img" aria-label="Sticker">{emoji||'Sticker'}</span></div>
  const isImage=kind==='photo'||kind==='sticker'
  const alt=kind==='sticker'?'Sticker':'Telegram photo'
  return <div className="msg__media">
    {url ? isImage ? <>
        <button type="button" ref={opener} className="msg__media-open" aria-label={kind==='sticker'?'Open sticker':'Open photo'} onClick={()=>setOpen(true)}><img src={url} alt={alt} loading="lazy" onError={failed}/></button>
        <button type="button" className="msg__btn msg__save" onClick={save}>Save</button>
      </> : <audio src={url} controls preload="metadata" aria-label={kind==='voice'?'Voice message':'Audio message'} onError={failed}/> : <button type="button" className="msg__btn" disabled={loading} onClick={()=>void load()}>{loading?'Loading media…':kind==='photo'?'View photo':kind==='sticker'?'View sticker':kind==='voice'?'Load voice message':'Load audio'}</button>}
    {error && <p role="status">{error}</p>}
    {open && url && createPortal(
      <div ref={dialog} className="msg-lightbox" role="dialog" aria-modal="true" aria-label={kind==='sticker'?'Sticker preview':'Photo preview'} tabIndex={-1} onClick={dismiss} onKeyDown={onDialogKey}>
        <div className="msg-lightbox__bar">
          <button type="button" ref={closer} className="msg__btn" onClick={close}>Close</button>
          <button type="button" className="msg__btn" onClick={save}>Save</button>
        </div>
        <div className="msg-lightbox__stage" onClick={dismiss}>
          <button type="button" className={`msg-lightbox__zoom${zoom?' is-zoomed':''}`} aria-label={zoom?'Zoom out':'Zoom in'} onClick={toggleZoom}>
            <img ref={image} src={url} alt={alt} style={zoom?{width:zoom.w,height:zoom.h,maxWidth:'none',maxHeight:'none'}:undefined}/>
          </button>
        </div>
      </div>,
      document.body)}
  </div>
}
