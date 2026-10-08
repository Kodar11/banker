import { memo } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { COLORS } from '@/constants/theme';

/**
 * The deliberately quiet middle of the board: wordmark + a faint city skyline.
 * No game information lives here — the squares around it carry all of that.
 */
export const BoardCenter = memo(function BoardCenter({ x, size }: { x: number; size: number }) {
  return (
    <View
      testID="board-center"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: 'absolute', left: x, top: x, width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    >
      <View style={{ position: 'absolute', left: size * 0.08, right: size * 0.08, bottom: size * 0.1, height: size * 0.32, opacity: 0.16 }}>
        <Svg width="100%" height="100%" viewBox="0 0 200 64" preserveAspectRatio="xMidYMax meet">
          {/* Gateway arch */}
          <Path d="M8 64 V30 H36 V64 H29 V44 Q22 34 15 44 V64 Z" fill={COLORS.felt} />
          <Rect x={6} y={26} width={32} height={5} fill={COLORS.felt} />
          {/* Towers */}
          <Rect x={42} y={18} width={12} height={46} fill={COLORS.felt} />
          <Rect x={56} y={30} width={10} height={34} fill={COLORS.felt} />
          <Rect x={136} y={22} width={11} height={42} fill={COLORS.felt} />
          <Rect x={149} y={34} width={9} height={30} fill={COLORS.felt} />
          {/* Domed monument with minarets */}
          <Rect x={72} y={22} width={3} height={42} fill={COLORS.felt} />
          <Rect x={125} y={22} width={3} height={42} fill={COLORS.felt} />
          <Path d="M80 64 V40 H120 V64 Z M84 40 Q100 8 116 40 Z" fill={COLORS.felt} />
          <Rect x={99} y={6} width={2} height={8} fill={COLORS.felt} />
          {/* Clock tower */}
          <Path d="M164 64 V20 L170 10 L176 20 V64 Z" fill={COLORS.felt} />
          <Circle cx={170} cy={26} r={3} fill={COLORS.board} />
          <Rect x={180} y={38} width={14} height={26} fill={COLORS.felt} />
        </Svg>
      </View>
      <View style={{ height: 1, width: size * 0.42, backgroundColor: COLORS.boardEdge, marginBottom: size * 0.035 }} />
      <Text style={{ fontSize: size * 0.105, fontWeight: '900', color: COLORS.felt, letterSpacing: size * 0.012, includeFontPadding: false }} numberOfLines={1} allowFontScaling={false}>
        BUSINESS
      </Text>
      <Text allowFontScaling={false} numberOfLines={1} style={{ includeFontPadding: false, fontSize: size * 0.034, fontWeight: '700', color: '#8A7A55', letterSpacing: size * 0.012, marginTop: 2 }}>CLASSIC · INDIA</Text>
      <View style={{ height: 1, width: size * 0.42, backgroundColor: COLORS.boardEdge, marginTop: size * 0.035 }} />
    </View>
  );
});
