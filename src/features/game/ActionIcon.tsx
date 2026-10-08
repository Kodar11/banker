import { memo } from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { COLORS } from '@/constants/theme';

export type ActionIconName = 'properties' | 'transfer' | 'pay' | 'bank' | 'auction' | 'more';

/**
 * Line icons for the action area, drawn on a 24 × 24 grid. Vector on purpose:
 * emoji look different on every phone and can't take the bar's colour.
 */
export const ActionIcon = memo(function ActionIcon({ name, size = 20, color = COLORS.cream }: { name: ActionIconName; size?: number; color?: string }) {
  const line = { stroke: color, strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;
  return (
    <Svg testID={`action-icon-${name}`} width={size} height={size} viewBox="0 0 24 24">
      {name === 'properties' ? (
        <>
          <Path {...line} d="M3 11.5 L12 4 L21 11.5" />
          <Path {...line} d="M5.5 10 V20 H18.5 V10" />
          <Path {...line} d="M10 20 V14.5 H14 V20" />
        </>
      ) : null}
      {name === 'transfer' ? (
        <>
          <Path {...line} d="M4 8 H19.5 M16 4.5 L19.5 8 L16 11.5" />
          <Path {...line} d="M20 16 H4.5 M8 12.5 L4.5 16 L8 19.5" />
        </>
      ) : null}
      {name === 'pay' ? (
        <>
          <Rect {...line} x={3} y={6.5} width={18} height={11} rx={2} />
          <Circle {...line} cx={12} cy={12} r={2.4} />
          <Path {...line} d="M6.5 12 H6.6 M17.4 12 H17.5" />
        </>
      ) : null}
      {name === 'bank' ? (
        <>
          <Path {...line} d="M3.5 9.5 L12 4 L20.5 9.5 Z" />
          <Path {...line} d="M6 12.5 V16.5 M10 12.5 V16.5 M14 12.5 V16.5 M18 12.5 V16.5" />
          <Path {...line} d="M3.5 19.5 H20.5" />
        </>
      ) : null}
      {name === 'auction' ? (
        <>
          <Path {...line} d="M9.5 7.5 L13.5 3.5 L19.5 9.5 L15.5 13.5 Z" />
          <Path {...line} d="M12.5 10.5 L4.5 18.5" />
          <Path {...line} d="M13 20.5 H21" />
        </>
      ) : null}
      {name === 'more' ? (
        <>
          <Circle cx={5} cy={12} r={1.9} fill={color} />
          <Circle cx={12} cy={12} r={1.9} fill={color} />
          <Circle cx={19} cy={12} r={1.9} fill={color} />
        </>
      ) : null}
    </Svg>
  );
});
