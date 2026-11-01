import { useEffect,useRef,useState } from 'react'
import { ApiError } from '@aelys/shared'
import { getSharedApiClient } from '../lib/api'

export function TelegramMediaPreview({messageId,version,kind}:{messageId:string;version:number;kind:'photo'|'voice'|'audio'}) {
  const [url,setUrl]=useState<string>()
  const [loading,setLoading]=useState(false)
  const [error,setError]=useState('')
  const generation=useRef(0)
  const currentUrl=useRef<string|undefined>(undefined)
  const controller=useRef<AbortController|undefined>(undefined)
  const working=useRef(false)
  useEffect(()=>{
    setUrl(undefined);setLoading(false);setError('');working.current=false
    return ()=>{generation.current+=1;controller.current?.abort();if(currentUrl.current){URL.revokeObjectURL(currentUrl.current);currentUrl.current=undefined}}
  },[messageId,version])
  const load=async()=>{
    if(working.current)return
    working.current=true;setLoading(true);setError('')
    const request=++generation.current
    controller.current=new AbortController()
    try {
      const blob=await getSharedApiClient().telegramMessageMedia(messageId,{signal:controller.current.signal})
      if(request!==generation.current)return
      const expected=kind==='photo'?'image/':'audio/'
      if(!blob.type.startsWith(expected))throw new Error('Unexpected media type')
      if(currentUrl.current)URL.revokeObjectURL(currentUrl.current)
      currentUrl.current=URL.createObjectURL(blob);setUrl(currentUrl.current)
    } catch(cause){
      if(request!==generation.current)return
      setError(cause instanceof ApiError && cause.code==='TELEGRAM_MEDIA_TOO_LARGE'?'This file is too large to preview. Open it in Telegram.':'Could not load this media. Try again or open it in Telegram.')
    } finally {if(request===generation.current){working.current=false;setLoading(false)}}
  }
  const failed=()=>setError('This media format could not be played or displayed. Open it in Telegram.')
  return <div className="msg__media">
    {url ? kind==='photo' ? <img src={url} alt="Telegram photo" loading="lazy" onError={failed}/> : <audio src={url} controls preload="metadata" aria-label={kind==='voice'?'Voice message':'Audio message'} onError={failed}/> : <button type="button" className="msg__btn" disabled={loading} onClick={()=>void load()}>{loading?'Loading media…':kind==='photo'?'View photo':kind==='voice'?'Load voice message':'Load audio'}</button>}
    {error && <p role="status">{error}</p>}
  </div>
}
