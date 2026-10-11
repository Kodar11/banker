import { memo, useMemo, type ComponentType, type ReactNode } from 'react';
import { Animated, View } from 'react-native';
import { COLORS, PROPERTY_GROUP_THEME, type PlayerColor } from '@/constants/theme';
import type { OnboardingSceneId } from './content';
import {
  Amount,
  BoardCrop,
  BOUGHT,
  CARD,
  Coin,
  COIN,
  DealMark,
  DeedCard,
  DESTINATION_INDEX,
  DIE,
  DieBody,
  DieFace,
  HOUSE,
  HousePiece,
  OFFERED,
  OwnerBadge,
  OwnerEdge,
  PURSE,
  Purse,
  RENT,
  RIVAL_INDEX,
  ROLL,
  SEATS,
  SHARE,
  STAGE,
  STRIP,
  TILE,
  Tile,
  TileGlow,
  tileX,
  TokenPiece,
  tokenSpot,
} from './pieces';
import { ease, track, useTimeline, type Move } from './timeline';

type Num = Animated.AnimatedInterpolation<number> | number;
type Angle = Animated.AnimatedInterpolation<string> | string;

/** A scene's clock, as the two kinds of value its pieces are driven by. */
interface Scene {
  num: (initial: number, moves: readonly Move[]) => Animated.AnimatedInterpolation<number>;
  deg: (initial: number, moves: readonly Move[]) => Animated.AnimatedInterpolation<string>;
}

function useScene(total: number): Scene {
  const clock = useTimeline(total);
  return useMemo(
    () => ({
      num: (initial, moves) => clock.interpolate(track(total, initial, moves)),
      deg: (initial, moves) => {
        const { outputRange, ...range } = track(total, initial, moves);
        return clock.interpolate({ ...range, outputRange: outputRange.map((value) => `${value}deg`) });
      },
    }),
    [clock, total],
  );
}

interface AtProps {
  x: Num;
  y: Num;
  opacity?: Num;
  scale?: Num;
  rotate?: Angle;
  children: ReactNode;
}

/** A piece at a place on the stage. Only transforms and opacity ever change, so the native driver runs it all. */
function At({ x, y, opacity = 1, scale = 1, rotate = '0deg', children }: AtProps) {
  return <Animated.View style={{ position: 'absolute', left: 0, top: 0, opacity, transform: [{ translateX: x }, { translateY: y }, { scale }, { rotate }] }}>{children}</Animated.View>;
}

/** The whole picture arrives with a short fade and a slight growth. */
function Stage({ scene, children }: { scene: Scene; children: ReactNode }) {
  return (
    <Animated.View style={{ width: STAGE.width, height: STAGE.height, opacity: scene.num(0, [[0, 300, 1]]), transform: [{ scale: scene.num(0.94, [[0, 380, 1]]) }] }}>
      <BoardCrop>
        {STRIP.map((tile, index) => (
          <Tile key={index} tile={tile} index={index} />
        ))}
        {children}
      </BoardCrop>
    </Animated.View>
  );
}

const HOP_MS = 260;
const HOP_LIFT = 12;

/** A token hopping square by square from one spot to another, as it does on the real board. */
function walk(start: number, from: { x: number; y: number }, to: { x: number; y: number }, steps: number): { x: Move[]; y: Move[]; end: number } {
  const x: Move[] = [];
  const y: Move[] = [];
  for (let i = 0; i < steps; i++) {
    const at = start + i * HOP_MS;
    x.push([at, at + HOP_MS, from.x + ((to.x - from.x) * (i + 1)) / steps, ease.inOut]);
    y.push([at, at + HOP_MS / 2, from.y - HOP_LIFT, ease.out], [at + HOP_MS / 2, at + HOP_MS, to.y, ease.in]);
  }
  return { x, y, end: start + steps * HOP_MS };
}

/** A small jump on the spot. */
function bounce(start: number, y: number, height: number): Move[] {
  return [
    [start, start + 150, y - height, ease.out],
    [start + 150, start + 300, y, ease.in],
    [start + 300, start + 400, y - height * 0.35, ease.out],
    [start + 400, start + 500, y, ease.in],
  ];
}

const THROW_MS = 700;
const REROLL_MS = 600;

interface DieProps {
  scene: Scene;
  /** When it is thrown onto the board. */
  at: number;
  from: { x: number; y: number; turn: number };
  to: { x: number; y: number; turn: number };
  face: 1 | 2;
  /** A second roll, picked up and thrown again where it lies, landing on another face. */
  reroll?: { at: number; face: 1 | 2 };
}

function Die({ scene, at, from, to, face, reroll }: DieProps) {
  const lifted = reroll ? reroll.at + REROLL_MS / 2 : 0;
  const again = (rest: number, peak: number): Move[] => (reroll ? [[reroll.at, lifted, peak, ease.out], [lifted, reroll.at + REROLL_MS, rest, ease.in]] : []);
  const swap = reroll ? scene.num(0, [[lifted - 50, lifted + 50, 1, ease.linear]]) : 0;
  return (
    <At
      x={scene.num(from.x, [[at, at + THROW_MS, to.x]])}
      y={scene.num(from.y, [[at, at + THROW_MS, to.y], ...again(to.y, to.y - 16)])}
      opacity={scene.num(0, [[at, at + 140, 1, ease.linear]])}
      scale={scene.num(1.2, [[at, at + THROW_MS * 0.7, 0.95, ease.in], [at + THROW_MS * 0.7, at + THROW_MS, 1], ...again(1, 1.15)])}
      rotate={scene.deg(from.turn, [[at, at + THROW_MS, to.turn], ...(reroll ? ([[reroll.at, reroll.at + REROLL_MS, to.turn + 360, ease.inOut]] satisfies Move[]) : [])])}
    >
      <DieBody>
        <Animated.View style={{ opacity: reroll ? scene.num(1, [[lifted - 50, lifted + 50, 0, ease.linear]]) : 1 }}>
          <DieFace value={face} />
        </Animated.View>
        {reroll ? (
          <Animated.View style={{ opacity: swap }}>
            <DieFace value={reroll.face} />
          </Animated.View>
        ) : null}
      </DieBody>
    </At>
  );
}

/** The two dice, thrown in from either side so they never arrive together. `top` is where they come to rest. */
function Dice({ scene, at, top, rerollAt }: { scene: Scene; at: number; top: number; rerollAt?: number }) {
  const middle = STAGE.width / 2;
  return (
    <>
      <Die
        scene={scene}
        at={at}
        face={ROLL[0]}
        from={{ x: middle - 120, y: top - 28, turn: -380 }}
        to={{ x: middle - DIE - 5, y: top, turn: -12 }}
        reroll={rerollAt === undefined ? undefined : { at: rerollAt, face: ROLL[1] }}
      />
      <Die
        scene={scene}
        at={at + 150}
        face={ROLL[1]}
        from={{ x: middle + 90, y: top + 50, turn: 400 }}
        to={{ x: middle + 5, y: top + 9, turn: 14 }}
        reroll={rerollAt === undefined ? undefined : { at: rerollAt + 80, face: ROLL[0] }}
      />
    </>
  );
}

/** A square becoming someone's: it glows once, then keeps the owner's edge and tick. `at: null` = owned all along. */
function Ownership({ scene, index, seat, at }: { scene: Scene; index: number; seat: PlayerColor; at: number | null }) {
  const x = tileX(index);
  return (
    <>
      <At x={x} y={TILE.top + TILE.height - TILE.owner} opacity={at === null ? 1 : scene.num(0, [[at, at + 250, 1]])}>
        <OwnerEdge seat={seat} />
      </At>
      {at === null ? null : (
        <At x={x - 3} y={TILE.top - 3} opacity={scene.num(0, [[at, at + 220, 1], [at + 520, at + 950, 0, ease.in]])}>
          <TileGlow />
        </At>
      )}
      <At x={x + TILE.width - 12} y={TILE.top - 7} scale={at === null ? 1 : scene.num(0, [[at + 80, at + 430, 1, ease.pop]])}>
        <OwnerBadge seat={seat} />
      </At>
    </>
  );
}

/** A house set down on a square's colour band. `at: null` = already built. */
function House({ scene, index, at }: { scene: Scene; index: number; at: number | null }) {
  const top = TILE.top + (TILE.band - HOUSE) / 2;
  return (
    <At
      x={tileX(index) + (TILE.width - HOUSE) / 2}
      y={at === null ? top : scene.num(top - 12, [[at, at + 300, top]])}
      opacity={at === null ? 1 : scene.num(0, [[at, at + 120, 1, ease.linear]])}
      scale={at === null ? 1 : scene.num(0.4, [[at, at + 400, 1, ease.pop]])}
    >
      <HousePiece />
    </At>
  );
}

const OWNER = SEATS[0];
const RIVAL = SEATS[1];
/** Where the owner and the rival stand: both start on the first square and end on the bought one. */
const OWNER_FROM = tokenSpot(0, -SHARE);
const OWNER_TO = tokenSpot(DESTINATION_INDEX, -SHARE);
const RIVAL_FROM = tokenSpot(0, SHARE);
const RIVAL_TO = tokenSpot(DESTINATION_INDEX, SHARE);

// ---------------------------------------------------------------------------
// 1 — Every roll starts a rivalry: roll, move, buy, build.
// ---------------------------------------------------------------------------

const RIVALRY_MS = 4300;

const RivalryScene = memo(function RivalryScene() {
  const scene = useScene(RIVALRY_MS);
  const from = tokenSpot(0);
  const to = tokenSpot(DESTINATION_INDEX);
  const move = walk(1400, from, to, DESTINATION_INDEX);
  const bought = move.end + 150;
  return (
    <Stage scene={scene}>
      <Ownership scene={scene} index={DESTINATION_INDEX} seat={OWNER} at={bought} />
      <House scene={scene} index={DESTINATION_INDEX} at={bought + 800} />
      <At x={scene.num(from.x, move.x)} y={scene.num(from.y, move.y)}>
        <TokenPiece seat={OWNER} />
      </At>
      <Dice scene={scene} at={300} top={44} />
    </Stage>
  );
});

// ---------------------------------------------------------------------------
// 2 — Roll. Buy. Collect. Repeat: one player buys, the next lands there and pays rent.
// ---------------------------------------------------------------------------

const TURN_MS = 6900;
const PURSE_TOP = 10;
const OWNER_PURSE = 10;
const RIVAL_PURSE = STAGE.width - PURSE.width - 10;
/** The coin drawn inside a purse sits this far in: rent leaves one purse's coins and joins the other's. */
const PURSE_COIN = { x: 26, y: (PURSE.height - COIN) / 2 };
const RENT_COINS = [0, 1, 2];
const COIN_FLIGHT_MS = 650;

const TurnScene = memo(function TurnScene() {
  const scene = useScene(TURN_MS);
  const ownerMove = walk(1050, OWNER_FROM, OWNER_TO, DESTINATION_INDEX);
  const bought = ownerMove.end + 120;
  const rerollAt = bought + 750;
  const rivalMove = walk(rerollAt + REROLL_MS + 230, RIVAL_FROM, RIVAL_TO, DESTINATION_INDEX);
  const rentAt = rivalMove.end + 220;
  const received = rentAt + COIN_FLIGHT_MS;
  const coinY = PURSE_TOP + PURSE_COIN.y;
  return (
    <Stage scene={scene}>
      <Ownership scene={scene} index={DESTINATION_INDEX} seat={OWNER} at={bought} />
      <House scene={scene} index={DESTINATION_INDEX} at={received + 800} />
      <At x={scene.num(RIVAL_FROM.x, rivalMove.x)} y={scene.num(RIVAL_FROM.y, rivalMove.y)}>
        <TokenPiece seat={RIVAL} />
      </At>
      <At x={scene.num(OWNER_FROM.x, ownerMove.x)} y={scene.num(OWNER_FROM.y, ownerMove.y)}>
        <TokenPiece seat={OWNER} />
      </At>
      <At x={OWNER_PURSE} y={PURSE_TOP} scale={scene.num(1, [[received, received + 200, 1.08], [received + 200, received + 420, 1, ease.inOut]])}>
        <Purse seat={OWNER}>
          <Animated.View style={{ opacity: scene.num(0, [[received, received + 250, 1]]) }}>
            <Amount value={RENT} />
          </Animated.View>
        </Purse>
      </At>
      <At x={RIVAL_PURSE} y={PURSE_TOP}>
        <Purse seat={RIVAL}>
          <Animated.View style={{ opacity: scene.num(0, [[rentAt, rentAt + 250, 1]]) }}>
            <Amount value={-RENT} />
          </Animated.View>
        </Purse>
      </At>
      <Dice scene={scene} at={200} top={58} rerollAt={rerollAt} />
      {RENT_COINS.map((i) => {
        const at = rentAt + i * 150;
        return (
          <At
            key={i}
            x={scene.num(RIVAL_PURSE + PURSE_COIN.x, [[at, at + COIN_FLIGHT_MS, OWNER_PURSE + PURSE_COIN.x, ease.inOut]])}
            y={scene.num(coinY, [[at, at + COIN_FLIGHT_MS / 2, coinY - 12], [at + COIN_FLIGHT_MS / 2, at + COIN_FLIGHT_MS, coinY, ease.in]])}
            opacity={scene.num(0, [[at, at + 80, 1, ease.linear], [at + COIN_FLIGHT_MS - 80, at + COIN_FLIGHT_MS, 0, ease.linear]])}
          >
            <Coin />
          </At>
        );
      })}
    </Stage>
  );
});

// ---------------------------------------------------------------------------
// 3 — Every game tells a new story: more players, and a trade two of them agree on.
// ---------------------------------------------------------------------------

const TRADE_MS = 4600;
const CARD_TOP = 18;
const CARD_GAP = 12;
const LEFT_CARD = STAGE.width / 2 - CARD_GAP / 2 - CARD.width;
const RIGHT_CARD = STAGE.width / 2 + CARD_GAP / 2;
const CARD_SLIDE = 70;
/** The two players who join: on the squares furthest apart that are not the bought one. */
const NEWCOMERS = [
  { seat: SEATS[2], spot: tokenSpot(0), at: 300 },
  { seat: SEATS[3], spot: tokenSpot(DESTINATION_INDEX - 1), at: 460 },
];
const CONFETTI_FROM = { x: STAGE.width / 2 - 3, y: 56 };
/** A small, fixed burst: where each piece lands relative to the middle, and how far it spins. */
const CONFETTI: readonly { dx: number; dy: number; spin: number; color: string }[] = [
  { dx: -92, dy: -30, spin: 200, color: COLORS.saffron },
  { dx: -64, dy: 18, spin: -160, color: PROPERTY_GROUP_THEME.BLUE.color },
  { dx: -38, dy: -42, spin: 140, color: PROPERTY_GROUP_THEME.PINK.color },
  { dx: -16, dy: 30, spin: -220, color: PROPERTY_GROUP_THEME.GREEN.color },
  { dx: 12, dy: -46, spin: 180, color: COLORS.saffron },
  { dx: 36, dy: 26, spin: -140, color: PROPERTY_GROUP_THEME.PURPLE.color },
  { dx: 60, dy: -36, spin: 240, color: PROPERTY_GROUP_THEME.GREEN.color },
  { dx: 90, dy: 12, spin: -200, color: PROPERTY_GROUP_THEME.PINK.color },
];

const TradeScene = memo(function TradeScene() {
  const scene = useScene(TRADE_MS);
  const cardsAt = 900;
  const settled = cardsAt + 700;
  const coinAt = settled + 300;
  const dealAt = coinAt + 750;
  const cheerAt = dealAt + 450;
  const coinY = CARD_TOP + CARD.height + 8;
  const coinFrom = LEFT_CARD + (CARD.width - COIN) / 2;
  const coinTo = RIGHT_CARD + (CARD.width - COIN) / 2;
  const agree = (): Move[] => [
    [dealAt, dealAt + 150, 1.06],
    [dealAt + 150, dealAt + 320, 1, ease.inOut],
  ];
  return (
    <Stage scene={scene}>
      <Ownership scene={scene} index={DESTINATION_INDEX} seat={OWNER} at={null} />
      <Ownership scene={scene} index={RIVAL_INDEX} seat={RIVAL} at={null} />
      <House scene={scene} index={DESTINATION_INDEX} at={null} />
      {NEWCOMERS.map(({ seat, spot, at }, i) => (
        <At
          key={seat.name}
          x={spot.x}
          y={scene.num(spot.y - 14, [[at, at + 300, spot.y], ...bounce(cheerAt + (i + 2) * 110, spot.y, 10)])}
          opacity={scene.num(0, [[at, at + 120, 1, ease.linear]])}
          scale={scene.num(0.3, [[at, at + 380, 1, ease.pop]])}
        >
          <TokenPiece seat={seat} />
        </At>
      ))}
      <At x={RIVAL_TO.x} y={scene.num(RIVAL_TO.y, bounce(cheerAt + 110, RIVAL_TO.y, 10))}>
        <TokenPiece seat={RIVAL} />
      </At>
      <At x={OWNER_TO.x} y={scene.num(OWNER_TO.y, bounce(cheerAt, OWNER_TO.y, 10))}>
        <TokenPiece seat={OWNER} />
      </At>
      <At
        x={scene.num(LEFT_CARD - CARD_SLIDE, [[cardsAt, settled, LEFT_CARD]])}
        y={CARD_TOP}
        opacity={scene.num(0, [[cardsAt, cardsAt + 180, 1, ease.linear]])}
        scale={scene.num(1, agree())}
        rotate={scene.deg(-20, [[cardsAt, settled, -6]])}
      >
        <DeedCard deed={BOUGHT} seat={OWNER} />
      </At>
      <At
        x={scene.num(RIGHT_CARD + CARD_SLIDE, [[cardsAt + 80, settled + 80, RIGHT_CARD]])}
        y={CARD_TOP}
        opacity={scene.num(0, [[cardsAt + 80, cardsAt + 260, 1, ease.linear]])}
        scale={scene.num(1, agree())}
        rotate={scene.deg(20, [[cardsAt + 80, settled + 80, 6]])}
      >
        <DeedCard deed={OFFERED} seat={RIVAL} />
      </At>
      <At
        x={scene.num(coinFrom, [[coinAt + 150, coinAt + 750, coinTo, ease.inOut]])}
        y={scene.num(coinY, [[coinAt + 150, coinAt + 450, coinY + 7], [coinAt + 450, coinAt + 750, coinY, ease.in]])}
        opacity={scene.num(0, [[coinAt, coinAt + 120, 1, ease.linear]])}
        scale={scene.num(0.4, [[coinAt, coinAt + 300, 1, ease.pop]])}
      >
        <Coin />
      </At>
      <At x={STAGE.width / 2 - 14} y={CARD_TOP + CARD.height / 2 - 14} opacity={scene.num(0, [[dealAt, dealAt + 100, 1, ease.linear]])} scale={scene.num(0.3, [[dealAt, dealAt + 380, 1, ease.pop]])}>
        <DealMark />
      </At>
      {CONFETTI.map(({ dx, dy, spin, color }, i) => (
        <At
          key={i}
          x={scene.num(CONFETTI_FROM.x, [[cheerAt, cheerAt + 700, CONFETTI_FROM.x + dx]])}
          y={scene.num(CONFETTI_FROM.y, [[cheerAt, cheerAt + 450, CONFETTI_FROM.y + dy], [cheerAt + 450, cheerAt + 1000, CONFETTI_FROM.y + dy + 14, ease.in]])}
          opacity={scene.num(0, [[cheerAt, cheerAt + 80, 1, ease.linear], [cheerAt + 600, cheerAt + 1000, 0, ease.linear]])}
          rotate={scene.deg(0, [[cheerAt, cheerAt + 1000, spin]])}
        >
          <View style={{ width: 6, height: 9, borderRadius: 1.5, backgroundColor: color }} />
        </At>
      ))}
    </Stage>
  );
});

/** Past this the pieces would look blown up (tablets): the scene stays a board on the table. */
const MAX_SCALE = 1.7;

const SCENES: Record<OnboardingSceneId, ComponentType> = { rivalry: RivalryScene, turn: TurnScene, trade: TradeScene };

/**
 * One of the introduction's scenes, scaled to fit a `width` × `height` area without ever being
 * stretched. Mount it only while its page is on screen: mounting plays it, unmounting stops it.
 */
export function OnboardingScene({ scene, width, height }: { scene: OnboardingSceneId; width: number; height: number }) {
  const Play = SCENES[scene];
  const scale = Math.min(width / STAGE.width, height / STAGE.height, MAX_SCALE);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return (
    <View testID={`onboarding-scene-${scene}`} pointerEvents="none" style={{ width: STAGE.width * scale, height: STAGE.height * scale }}>
      <View style={{ width: STAGE.width, height: STAGE.height, transformOrigin: 'top left', transform: [{ scale }] }}>
        <Play />
      </View>
    </View>
  );
}

