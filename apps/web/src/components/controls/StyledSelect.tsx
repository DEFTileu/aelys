import { Children, isValidElement, useRef, type ReactNode, type SelectHTMLAttributes } from 'react'
import { SelectField, type SelectOption } from './SelectionControls'

function text(node:ReactNode):string { return Children.toArray(node).map(child=>typeof child==='string'||typeof child==='number' ? String(child) : isValidElement<{children?:ReactNode}>(child) ? text(child.props.children) : '').join('') }
function choices(children:ReactNode, groupDisabled=false):SelectOption[] {
  return Children.toArray(children).flatMap(child=> {
    if(!isValidElement<{children?:ReactNode;value?:string|number;disabled?:boolean}>(child)) return []
    if(child.type==='option') return [{value:String(child.props.value??text(child.props.children)),label:text(child.props.children),disabled:groupDisabled||child.props.disabled}]
    return choices(child.props.children,groupDisabled||child.props.disabled)
  })
}
/** Keeps the native form value/validation contract while presenting the shared picker. */
export function StyledSelect({children,className,...props}:SelectHTMLAttributes<HTMLSelectElement>) {
  const native=useRef<HTMLSelectElement>(null)
  const root=useRef<HTMLDivElement>(null)
  const options=choices(children)
  const label=typeof props['aria-label']==='string'?props['aria-label']:props.name||'Select option'
  return <div ref={root} className={`styled-select${className?` ${className}`:''}`}>
    <select {...props} ref={native} className="styled-select__native" tabIndex={-1} aria-hidden="true" onInvalid={event=>{props.onInvalid?.(event);root.current?.querySelector<HTMLButtonElement>('[role=combobox]')?.focus()}}>{children}</select>
    <SelectField label={label} hideLabel value={String(props.value??props.defaultValue??options[0]?.value??'')} options={options} disabled={props.disabled} error={props['aria-invalid']===true?'Choose a valid option':undefined} onChange={value=>{
      if(!native.current||props.disabled)return
      native.current.value=value
      native.current.dispatchEvent(new Event('change',{bubbles:true}))
    }}/>
  </div>
}
