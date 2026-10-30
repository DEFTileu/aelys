import './switch.css'

type Props = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  pending?: boolean
  describedBy?: string
}

/** Controlled switch: pending requests never optimistically change its value. */
export function Switch({ checked, onCheckedChange, label, disabled = false, pending = false, describedBy }: Props) {
  return <button type="button" className="aelys-switch" role="switch" aria-label={label}
    aria-checked={checked} aria-busy={pending || undefined} aria-describedby={describedBy}
    disabled={disabled || pending} onClick={() => onCheckedChange(!checked)}>
    <span className="aelys-switch__track" aria-hidden="true">
      <span className="aelys-switch__thumb">{pending && <span className="aelys-switch__progress" />}</span>
    </span>
  </button>
}
