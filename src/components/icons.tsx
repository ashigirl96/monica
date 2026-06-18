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

export function DashboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M3 10.5L12 3L21 10.5V20C21 20.6 20.6 21 20 21H4C3.4 21 3 20.6 3 20V10.5Z"
        strokeWidth="1.5"
      />
      <path d="M9 21V14H15V21" strokeWidth="1.5" />
    </Icon>
  );
}

export function ProjectHomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5Z" strokeWidth="1.5" />
      <path d="M12 12L12 21M12 12L4 7.5M12 12L20 7.5" strokeWidth="1.5" />
    </Icon>
  );
}

export function MemoryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M5 5.5C5 4.7 5.7 4 6.5 4H18C18.6 4 19 4.4 19 5V20L16 18.2L13 20L10 18.2L7 20L5 18.8V5.5Z"
        strokeWidth="1.5"
      />
      <path d="M8 8H16" strokeWidth="1.5" />
      <path d="M8 11.5H15" strokeWidth="1.5" />
      <path d="M8 15H13" strokeWidth="1.5" />
    </Icon>
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

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="5.5" strokeWidth="1.5" />
      <path d="M15 15L20 20" strokeWidth="1.5" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4V15" strokeWidth="1.5" />
      <path d="M8 11L12 15L16 11" strokeWidth="1.5" />
      <path d="M5 20H19" strokeWidth="1.5" />
    </Icon>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 17L17 7" strokeWidth="1.5" />
      <path d="M9 7H17V15" strokeWidth="1.5" />
    </Icon>
  );
}
