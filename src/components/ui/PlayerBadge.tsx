import { memo } from 'react';
import { Text, View } from 'react-native';
import { playerColor, playerInitial } from '@/constants/theme';

interface PlayerBadgeProps {
  player: { name: string; seat: number };
  size?: number;
  testID?: string;
  /** A plain colour token, like the pieces on the board. Use it only next to the player's name. */
  plain?: boolean;
}

/**
 * A player's identity mark: their seat colour + initial. The initial means
 * identity never depends on colour alone.
 */
export const PlayerBadge = memo(function PlayerBadge({ player, size = 22, testID, plain = false }: PlayerBadgeProps) {
  const c = playerColor(player);
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: c.color,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: Math.max(1, size / 14),
        borderColor: 'rgba(255,255,255,0.85)',
      }}
    >
      {plain ? null : (
        <Text allowFontScaling={false} style={{ color: c.onColor, fontSize: size * 0.5, fontWeight: '900', lineHeight: size * 0.62, includeFontPadding: false }}>{playerInitial(player.name)}</Text>
      )}
    </View>
  );
});
