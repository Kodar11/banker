import type { PropertyGroup } from '@/engine/index.ts';

/** Colours used where NativeWind classes can't be (SVG, dynamic values). Mirrors tailwind.config.js. */
export const COLORS = {
  felt: '#0F5132',
  feltDark: '#0A3A24',
  cream: '#FFF8E7',
  ink: '#1F1B16',
  saffron: '#F59E0B',
  brick: '#C2410C',
};

export const GROUP_COLORS: Record<PropertyGroup, string> = {
  BLUE: '#2563EB',
  PURPLE: '#7C3AED',
  GREEN: '#16A34A',
  PINK: '#DB2777',
  TRANSPORT_UTILITY: '#475569',
};
