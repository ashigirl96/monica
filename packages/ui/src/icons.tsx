import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 18, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  )
}

export function PromptIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <polyline points="4,6 9,12 4,18" strokeWidth="1.8" />
      <line x1="12" y1="18" x2="20" y2="18" strokeWidth="1.8" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="12" y1="5" x2="12" y2="19" strokeWidth="1.5" />
      <line x1="5" y1="12" x2="19" y2="12" strokeWidth="1.5" />
    </Icon>
  )
}

export function PinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z" strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="12" y1="15" x2="12" y2="20" strokeWidth="1.5" />
    </Icon>
  )
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Icon>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  )
}

export function XIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="6" y1="6" x2="18" y2="18" strokeWidth="1.5" />
      <line x1="18" y1="6" x2="6" y2="18" strokeWidth="1.5" />
    </Icon>
  )
}
