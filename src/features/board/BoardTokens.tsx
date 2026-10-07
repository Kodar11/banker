import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Text, View } from 'react-native';
import type { PlayerState } from '@/engine/index.ts';
import { COLORS, playerColor, playerInitial } from '@/constants/theme';
import { clusterOffsets, forwardSteps, squareCenter, type BoardGeometry } from './boardModel';

/** Longest move animated square-by-square (a dice roll). Longer/backward jumps (cards, Jail) glide directly. */
export const MAX_HOP_STEPS = 12;
export const HOP_MS = 170;
/** Native-driver transforms keep hops smooth while the JS thread applies snapshots. Tests flip this to observe values. */
export const tokenAnimation = { useNativeDriver: Platform.OS !== 'web' };

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => alive && setReduce(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduce);
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return reduce;
}

interface TokenProps {
  player: Pick<PlayerState, 'id' | 'name' | 'seat'>;
  /** AUTHORITATIVE board position from the game state. */
  position: number;
  offset: { x: number; y: number };
  geo: BoardGeometry;
  size: number;
  isCurrent: boolean;
  reduceMotion: boolean;
}

/**
 * A player's token. The animation only ever chases `position` (authoritative
 * state) — it never feeds back into game state. A newer position interrupts the
 * running hop; the token first settles on the previous authoritative square,
 * then hops on, so it always ends exactly where the server says it is.
 */
const Token = memo(function Token({ player, position, offset, geo, size, isCurrent, reduceMotion }: TokenProps) {
  const at = (index: number, off = offset) => {
    const c = squareCenter(geo, index);
    return { x: c.x + off.x - size / 2, y: c.y + off.y - size / 2 };
  };
  const [xy] = useState(() => new Animated.ValueXY(at(position)));
  const [lift] = useState(() => new Animated.Value(0));
  /** Last authoritative square the token fully reached. */
  const settled = useRef(position);
  /** Last authoritative square the token was asked to go to. */
  const requested = useRef(position);
  const running = useRef<Animated.CompositeAnimation | null>(null);
  const geoSize = geo.size;

  useEffect(() => {
    if (running.current) {
      // Interrupted by a newer authoritative position: settle on the previous target, then move on.
      const prev = running.current;
      running.current = null;
      prev.stop();
      settled.current = requested.current;
      xy.setValue(at(requested.current, { x: 0, y: 0 }));
      lift.setValue(0);
    }
    requested.current = position;
    const from = settled.current;
    const target = at(position);
    const steps = forwardSteps(from, position);
    const finish = () => {
      if (running.current !== anim) return; // superseded; the newer animation owns the token
      xy.setValue(target);
      lift.setValue(0);
      settled.current = position;
      running.current = null;
    };
    let anim: Animated.CompositeAnimation;
    if (steps === 0 || reduceMotion) {
      anim = Animated.timing(xy, { toValue: target, duration: steps === 0 ? 160 : 0, useNativeDriver: tokenAnimation.useNativeDriver });
    } else if (steps > MAX_HOP_STEPS) {
      anim = Animated.timing(xy, { toValue: target, duration: 450, easing: Easing.inOut(Easing.cubic), useNativeDriver: tokenAnimation.useNativeDriver });
    } else {
      const hops = Array.from({ length: steps }, (_, i) => {
        const last = i === steps - 1;
        return Animated.parallel([
          Animated.timing(xy, { toValue: last ? target : at(from + i + 1, { x: 0, y: 0 }), duration: HOP_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: tokenAnimation.useNativeDriver }),
          Animated.sequence([
            Animated.timing(lift, { toValue: -size * 0.55, duration: HOP_MS / 2, easing: Easing.out(Easing.quad), useNativeDriver: tokenAnimation.useNativeDriver }),
            Animated.timing(lift, { toValue: 0, duration: HOP_MS / 2, easing: Easing.in(Easing.quad), useNativeDriver: tokenAnimation.useNativeDriver }),
          ]),
        ]);
      });
      anim = Animated.sequence(hops);
    }
    running.current = anim;
    anim.start(finish);
    // `at` depends only on these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, offset.x, offset.y, geoSize, size, reduceMotion]);

  useEffect(
    () => () => {
      const anim = running.current;
      running.current = null;
      anim?.stop();
    },
    [],
  );

  const c = playerColor(player);
  const ring = isCurrent ? Math.max(2, size * 0.16) : 0;
  return (
    <Animated.View
      testID={`board-token-${player.id}`}
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: size,
        height: size,
        zIndex: isCurrent ? 2 : 1,
        transform: [{ translateX: xy.x }, { translateY: xy.y }, { translateY: lift }],
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.color,
          borderWidth: Math.max(1.5, size * 0.12),
          borderColor: '#FFFFFF',
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOpacity: 0.3,
          shadowRadius: 2,
          shadowOffset: { width: 0, height: 1 },
          elevation: 3,
        }}
      >
        <Text style={{ color: c.onColor, fontSize: size * 0.48, fontWeight: '900', lineHeight: size * 0.6 }}>{playerInitial(player.name)}</Text>
      </View>
      {isCurrent ? (
        <View
          testID={`board-token-current-${player.id}`}
          style={{
            position: 'absolute',
            left: -ring - 1,
            top: -ring - 1,
            width: size + 2 * ring + 2,
            height: size + 2 * ring + 2,
            borderRadius: size,
            borderWidth: ring,
            borderColor: COLORS.ink,
            opacity: 0.85,
          }}
        />
      ) : null}
    </Animated.View>
  );
});

export function tokenSize(geo: BoardGeometry): number {
  return Math.min(18, Math.max(10, geo.unit * 0.44));
}

/** All tokens, positioned from authoritative player positions. Bankrupt players leave the board. */
export const BoardTokens = memo(function BoardTokens({
  players,
  currentPlayerId,
  geo,
}: {
  players: PlayerState[];
  currentPlayerId: string | null;
  geo: BoardGeometry;
}) {
  const reduceMotion = useReduceMotion();
  const size = tokenSize(geo);
  const active = players.filter((p) => p.status !== 'BANKRUPT').sort((a, b) => a.seat - b.seat);
  const bySquare = new Map<number, string[]>();
  for (const p of active) bySquare.set(p.position, [...(bySquare.get(p.position) ?? []), p.id]);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: geo.size, height: geo.size }} testID="board-tokens">
      {active.map((p) => {
        const here = bySquare.get(p.position)!;
        const offset = clusterOffsets(here.length, size)[here.indexOf(p.id)]!;
        return (
          <Token
            key={p.id}
            player={p}
            position={p.position}
            offset={offset}
            geo={geo}
            size={size}
            isCurrent={p.id === currentPlayerId}
            reduceMotion={reduceMotion}
          />
        );
      })}
    </View>
  );
});
