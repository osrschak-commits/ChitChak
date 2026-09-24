/** Small interface marks share a rounded stroke across platforms. */
export function DecorativeIcon({ name, size = 20 }: {
  name: 'smile' | 'attachment' | 'friends' | 'lock' | 'sparkle' | 'level';
  size?: number;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'smile' && <><circle cx="12" cy="12" r="8.25" /><path d="M8.5 14a4.3 4.3 0 0 0 7 0" /><g fill="currentColor" stroke="none"><circle cx="9" cy="9.5" r=".9" /><circle cx="15" cy="9.5" r=".9" /></g></>}
      {name === 'attachment' && <path d="m8.5 12.5 6.1-6.1a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7.1-7.1l8-8M7 14l7.3-7.3a1.5 1.5 0 0 1 2.1 2.1l-6.1 6.1" />}
      {name === 'friends' && <><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-2a5.5 5.5 0 0 1 11 0v2M16 5.2a3 3 0 0 1 0 5.6M18 13a4.5 4.5 0 0 1 3 4.2V20" /></>}
      {name === 'lock' && <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>}
      {name === 'sparkle' && <path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />}
      {name === 'level' && <><path d="m5 13 7-8 7 8M5 19l7-8 7 8" /></>}
    </svg>
  );
}
