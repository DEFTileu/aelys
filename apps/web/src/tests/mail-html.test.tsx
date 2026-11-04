import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mailDocument } from '../views/mail/mailHtml'
import { MailBody } from '../views/mail/MailBody'
import type { MailMessage } from '@aelys/shared'
const client=vi.hoisted(()=>({mailMessage:vi.fn()}))
vi.mock('../lib/api',()=>({getSharedApiClient:()=>client}))
let root:ReturnType<typeof createRoot>|undefined
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)})
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.innerHTML='';vi.unstubAllGlobals()})
const html='<table><tr><td style="color: red; padding: 12px"><b>Rich message</b><img src="https://images.example.test/logo.png" alt="Brand logo"></td></tr></table>'
it('retains table formatting while blocking all network sources by default',()=>{
 const result=mailDocument(html+'<style>@import "https://evil.test/css";body{background:url(https://evil.test/pixel)}</style><div style="background-image:url(https://evil.test/bg);font-size:18px">text</div>')
 expect(result.remoteImages).toBe(1)
 const doc=new DOMParser().parseFromString(result.srcDoc,'text/html')
 expect(doc.querySelector('table b')?.textContent).toBe('Rich message')
 expect(doc.querySelector('td')?.getAttribute('style')).toContain('color: red')
 expect(doc.querySelector('img')?.getAttribute('src')).toBeNull()
 expect(result.srcDoc).not.toContain('evil.test')
 expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("img-src 'none'")
})
it('removes active content, forms, app paths and unsafe image/link schemes',()=>{
 const result=mailDocument('<script>parent.alert(1)</script><iframe src="https://evil.test"></iframe><form action="https://evil.test"><input autofocus></form><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><svg onload="x()"></svg><img src="file:///etc/passwd" onerror="x()"><img src="data:image/svg+xml,evil"><img src="/api/v1/me"><a href="javascript:alert(1)">bad</a><a href="https://safe.test/page" ping="https://evil.test">good</a>',true)
 const doc=new DOMParser().parseFromString(result.srcDoc,'text/html')
 expect(doc.querySelector('script,iframe,form,input,svg,base')).toBeNull()
 expect(doc.querySelectorAll('img[src]')).toHaveLength(0)
 expect(doc.querySelectorAll('[onerror],[onload],[ping]')).toHaveLength(0)
 expect(doc.querySelector('a')?.hasAttribute('href')).toBe(false)
 expect(doc.querySelector('a[href]')?.getAttribute('rel')).toBe('noopener noreferrer')
 expect(doc.querySelectorAll('meta[http-equiv]')).toHaveLength(1)
})
it('loads only HTTPS images after explicit consent and still strips CSS network requests',()=>{
 const result=mailDocument(html+'<img src="https://user:secret@evil.test/logo"><div style="background-image:url(https://evil.test/pixel)">x</div>',true)
 const doc=new DOMParser().parseFromString(result.srcDoc,'text/html')
 expect(doc.querySelectorAll('img[src]')).toHaveLength(1)
 expect(doc.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer')
 expect(result.srcDoc).not.toContain('evil.test')
 expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain('img-src https:')
})
it('renders HTML in an opaque sandbox and resets image consent on message change',async()=>{
 const message={id:'m1',version:1,body:'Plain preview'} as MailMessage
 client.mailMessage.mockResolvedValue({...message,body_html:html})
 const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host)
 await act(async()=>root!.render(<MailBody message={message} offline={false}/>))
 let frame=host.querySelector('iframe')!
 expect(frame.getAttribute('sandbox')).not.toMatch(/allow-scripts|allow-same-origin|allow-forms|allow-top-navigation/)
 expect(frame.srcdoc).toContain("img-src 'none'")
 expect(host.querySelector('table')).toBeNull()
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Load external images')!.click())
 expect(host.querySelector('iframe')?.srcdoc).toContain('img-src https:')
 client.mailMessage.mockResolvedValue({...message,id:'m2',body_html:html})
 await act(async()=>root!.render(<MailBody message={{...message,id:'m2'}} offline={false}/>))
 expect(host.querySelector('iframe')?.srcdoc).toContain("img-src 'none'")
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Plain text')!.click())
 expect(host.querySelector('iframe')).toBeNull();expect(host.textContent).toContain('Plain preview')
})
it('keeps cached text usable when offline HTML is absent',async()=>{
 client.mailMessage.mockRejectedValue(new Error('cache miss'))
 const host=document.createElement('div');document.body.appendChild(host);root=createRoot(host)
 await act(async()=>root!.render(<MailBody message={{id:'m1',body:'Saved text'} as MailMessage} offline/>))
 expect(host.textContent).toBe('Saved text')
 expect(client.mailMessage).toHaveBeenCalledWith('m1',{cacheOnly:true})
})
