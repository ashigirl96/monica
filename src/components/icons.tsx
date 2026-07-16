import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

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
  );
}

export function WorkBoardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="5" height="18" rx="1.5" strokeWidth="1.5" />
      <rect x="9.5" y="3" width="5" height="12" rx="1.5" strokeWidth="1.5" />
      <rect x="16" y="3" width="5" height="8" rx="1.5" strokeWidth="1.5" />
    </Icon>
  );
}

export function WorkBenchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <polyline points="4,6 9,12 4,18" strokeWidth="1.8" />
      <line x1="12" y1="18" x2="20" y2="18" strokeWidth="1.8" />
    </Icon>
  );
}

export function JournalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M5 4.5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z"
        strokeWidth="1.5"
      />
      <line x1="8" y1="9" x2="16" y2="9" strokeWidth="1.5" />
      <line x1="8" y1="13" x2="13" y2="13" strokeWidth="1.5" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="12" y1="5" x2="12" y2="19" strokeWidth="1.5" />
      <line x1="5" y1="12" x2="19" y2="12" strokeWidth="1.5" />
    </Icon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="6" y1="6" x2="18" y2="18" strokeWidth="1.5" />
      <line x1="18" y1="6" x2="6" y2="18" strokeWidth="1.5" />
    </Icon>
  );
}
