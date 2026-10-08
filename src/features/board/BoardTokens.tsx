import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, View } from 'react-native';
import type { PlayerState } from '@/engine/index.ts';
import { COLORS, playerColor } from '@/constants/theme';
import { clusterOffsets, forwardSteps, tokenAnchor, type BoardGeometry } from './boardModel';

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
  /** Read-only: opens the player's details. */
  onPress?: (playerId: string) => void;
}

/**
 * A player's token. The animation only ever chases `position` (authoritative
 * state) — it never feeds back into game state. A newer position interrupts the
 * running hop; the token first settles on the previous authoritative square,
 * then hops on, so it always ends exactly where the server says it is.
 */
const Token = memo(function Token({ player, position, offset, geo, size, isCurrent, reduceMotion, onPress }: TokenProps) {
  const at = (index: number, off = offset) => {
    const c = tokenAnchor(geo, index);
    return { x: c.x + off.x - size / 2, y: c.y + off.y - size / 2 };
  };
  /** Presentation only: put the token exactly on the authoritative square, no animation. */
  const snapTo = (index: number) => {
    xy.setValue(at(index));
    lift.setValue(0);
    settled.current = index;
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
    // Nothing sensible to animate (reduced motion, or a board that has no size yet): just be there.
    if (reduceMotion || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      snapTo(position);
      return;
    }
    const finish = () => {
      if (running.current !== anim) return; // superseded; the newer animation owns the token
      running.current = null;
      snapTo(position);
    };
    let anim: Animated.CompositeAnimation;
    if (steps === 0) {
      // Same square, new spot in the cluster (someone arrived or left).
      anim = Animated.timing(xy, { toValue: target, duration: 160, useNativeDriver: tokenAnimation.useNativeDriver });
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
  const ring = isCurrent ? Math.max(1.5, size * 0.13) : 0;
  return (
    <Animated.View
      testID={`board-token-${player.id}`}
      pointerEvents={onPress ? 'box-none' : 'none'}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: size,
        height: size,
        zIndex: isCurrent ? 2 : 1,
        transform: [{ translateX: xy.x }, { translateY: xy.y }],
      }}
    >
      {/* The hop's lift lives on its own view so no view ever carries the same transform key twice. */}
      <Animated.View
        testID={`board-token-lift-${player.id}`}
        style={{
          transform: [{ translateY: lift }],
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: c.color,
          borderWidth: Math.max(1, size * 0.1),
          borderColor: '#FFFFFF',
          shadowColor: '#000',
          shadowOpacity: 0.35,
          shadowRadius: 2,
          shadowOffset: { width: 0, height: 1 },
          elevation: 3,
        }}
      >
        {/* A playing piece, not a badge: colour only — a soft highlight, never a letter. */}
        <View style={{ position: 'absolute', left: '18%', top: '14%', width: '34%', height: '34%', borderRadius: size, backgroundColor: '#FFFFFF', opacity: 0.4 }} />
      </Animated.View>
      {isCurrent ? (
        <View
          testID={`board-token-current-${player.id}`}
          style={{
            position: 'absolute',
            left: -ring,
            top: -ring,
            width: size + 2 * ring,
            height: size + 2 * ring,
            borderRadius: size,
            borderWidth: ring,
            borderColor: COLORS.ink,
            opacity: 0.85,
          }}
        />
      ) : null}
      {onPress ? (
        <Pressable
          testID={`board-token-press-${player.id}`}
          onPress={() => onPress(player.id)}
          hitSlop={Math.max(4, (28 - size) / 2)}
          accessibilityRole="button"
          accessibilityLabel={`${player.name}'s token`}
          accessibilityHint="Shows player details"
          style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, borderRadius: size / 2 }}
        />
      ) : null}
    </Animated.View>
  );
});

export function tokenSize(geo: BoardGeometry): number {
  return geo.metrics.token;
}

/** All tokens, positioned from authoritative player positions. Bankrupt players leave the board. */
export const BoardTokens = memo(function BoardTokens({
  players,
  currentPlayerId,
  geo,
  onTokenPress,
}: {
  players: PlayerState[];
  currentPlayerId: string | null;
  geo: BoardGeometry;
  onTokenPress?: (playerId: string) => void;
}) {
  const reduceMotion = useReduceMotion();
  const size = tokenSize(geo);
  const active = players.filter((p) => p.status !== 'BANKRUPT').sort((a, b) => a.seat - b.seat);
  const bySquare = new Map<number, string[]>();
  for (const p of active) bySquare.set(p.position, [...(bySquare.get(p.position) ?? []), p.id]);
  return (
    <View pointerEvents={onTokenPress ? 'box-none' : 'none'} style={{ position: 'absolute', left: 0, top: 0, width: geo.size, height: geo.size }} testID="board-tokens">
      {active.map((p) => {
        const here = bySquare.get(p.position)!;
        const lane = geo.slots[p.position]?.parts.tokens.width ?? geo.cell;
        const offset = clusterOffsets(here.length, size, lane)[here.indexOf(p.id)]!;
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
            onPress={onTokenPress}
          />
        );
      })}
    </View>
  );
});
