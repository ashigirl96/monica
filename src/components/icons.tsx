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

export function LibraryIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M12 6C10.5 4.8 8.3 4.5 4.5 4.5C4 4.5 3.5 5 3.5 5.5V18C3.5 18.5 4 19 4.5 19C8.3 19 10.5 19.3 12 20.5"
        strokeWidth="1.5"
      />
      <path
        d="M12 6C13.5 4.8 15.7 4.5 19.5 4.5C20 4.5 20.5 5 20.5 5.5V18C20.5 18.5 20 19 19.5 19C15.7 19 13.5 19.3 12 20.5"
        strokeWidth="1.5"
      />
      <path d="M12 6V20.5" strokeWidth="1.5" />
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
