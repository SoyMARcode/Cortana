/**
 * Íconos de trazo fino, del color del texto (currentColor). Reemplazan a
 * los emojis para que se vean iguales en todos los sistemas.
 */
type Props = { className?: string };

function Svg({ className = 'h-4 w-4', children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const IconoMicrofono = (p: Props) => (
  <Svg {...p}>
    <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
    <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
  </Svg>
);

export const IconoMarcador = (p: Props) => (
  <Svg {...p}>
    <path d="M4 2.5h8v11l-4-2.5-4 2.5z" />
  </Svg>
);

export const IconoSobre = (p: Props) => (
  <Svg {...p}>
    <rect x="1.5" y="3.5" width="13" height="9" />
    <path d="M1.5 4l6.5 5 6.5-5" />
  </Svg>
);

export const IconoPersona = (p: Props) => (
  <Svg {...p}>
    <circle cx="8" cy="5.5" r="2.5" />
    <path d="M3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" />
  </Svg>
);

export const IconoReloj = (p: Props) => (
  <Svg {...p}>
    <circle cx="8" cy="8.5" r="5.5" />
    <path d="M8 5.5v3l2 1.5M3 2.5l-1.5 1.5M13 2.5l1.5 1.5" />
  </Svg>
);

export const IconoCheck = (p: Props) => (
  <Svg {...p}>
    <path d="M3 8.5l3 3 7-7" />
  </Svg>
);

/** El sello de Cortana: anillo de tinta con un punto ámbar. */
export function Sello({ className = 'h-[22px] w-[22px]' }: Props) {
  return (
    <span aria-hidden="true" className={`relative inline-block shrink-0 ${className}`}>
      <span className="absolute inset-0 rounded-full border-[3px] border-[var(--ink)]" />
      <span className="absolute -right-[5px] -top-[5px] h-[9px] w-[9px] rounded-full bg-[var(--amber)] shadow-[0_0_0_2px_var(--paper)]" />
    </span>
  );
}
