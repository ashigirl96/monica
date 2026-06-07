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
