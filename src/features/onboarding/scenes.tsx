import { memo, useMemo, type ComponentType, type ReactNode } from 'react';
import { Animated, View } from 'react-native';
import { COLORS, PROPERTY_GROUP_THEME, type PlayerColor } from '@/constants/theme';
import { formatINR } from '@/utils/currency';
import { ONBOARDING_LABELS, type OnboardingSceneId } from './content';
import {
  Amount,
  AUCTION_BIDS,
  AUCTION_INDEX,
  AUCTIONED,
  BankMark,
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
  GavelMark,
  HotelPiece,
  HOUSE,
  HousePiece,
  INSURANCE_MODE,
  MARK,
  MAX_HOUSES,
  MORTGAGE_CASH,
  MortgageMark,
  MortgageVeil,
  OFFERED,
  OwnerBadge,
  OwnerEdge,
  PURSE,
  Purse,
  RENT,
  RENT_LADDER,
  RIVAL_INDEX,
  ROLL,
  SEATS,
  SHARE,
  STAGE,
  STRIP,
  TAG,
  Tag,
  TagText,
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

/** A square's glow on its own: a property catching the eye for a moment. */
function Glow({ scene, index, at }: { scene: Scene; index: number; at: number }) {
  return (
    <At x={tileX(index) - 3} y={TILE.top - 3} opacity={scene.num(0, [[at, at + 220, 1], [at + 520, at + 950, 0, ease.in]])}>
      <TileGlow />
    </At>
  );
}

interface HouseProps {
  scene: Scene;
  index: number;
  /** When it is built; null = already there. */
  at: number | null;
  /** Sideways from the middle of the band, when a square holds more than one. */
  shift?: number;
  /** When it is taken off again (a hotel replaces the houses). */
  gone?: number;
}

/** A house set down on a square's colour band. */
function House({ scene, index, at, shift = 0, gone }: HouseProps) {
  const top = TILE.top + (TILE.band - HOUSE) / 2;
  const leaves: Move[] = gone === undefined ? [] : [[gone, gone + 150, 0, ease.linear]];
  return (
    <At
      x={tileX(index) + (TILE.width - HOUSE) / 2 + shift}
      y={at === null ? top : scene.num(top - 12, [[at, at + 300, top]])}
      opacity={at === null ? (leaves.length ? scene.num(1, leaves) : 1) : scene.num(0, [[at, at + 120, 1, ease.linear], ...leaves])}
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
const CONFETTI_MS = 1000;
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

/** The burst itself: every piece flies out, tumbles, and is gone within a second. */
function Confetti({ scene, at }: { scene: Scene; at: number }) {
  return (
    <>
      {CONFETTI.map(({ dx, dy, spin, color }, i) => (
        <At
          key={i}
          x={scene.num(CONFETTI_FROM.x, [[at, at + 700, CONFETTI_FROM.x + dx]])}
          y={scene.num(CONFETTI_FROM.y, [[at, at + 450, CONFETTI_FROM.y + dy], [at + 450, at + CONFETTI_MS, CONFETTI_FROM.y + dy + 14, ease.in]])}
          opacity={scene.num(0, [[at, at + 80, 1, ease.linear], [at + 600, at + CONFETTI_MS, 0, ease.linear]])}
          rotate={scene.deg(0, [[at, at + CONFETTI_MS, spin]])}
        >
          <View style={{ width: 6, height: 9, borderRadius: 1.5, backgroundColor: color }} />
        </At>
      ))}
    </>
  );
}

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
      <Confetti scene={scene} at={cheerAt} />
    </Stage>
  );
});

// ---------------------------------------------------------------------------
// 4 — More than just a roll of the dice: the same board, later in the game. One owner builds up
// to a hotel, borrows against a deed, insures, and wins an auction.
// ---------------------------------------------------------------------------

const TYCOON_MS = 9800;
const THIRD = SEATS[2];
/** The owner's coins pile up beside their purse, each a little higher than the last. */
const STACK = { x: OWNER_PURSE + PURSE.width + 6, y: PURSE_TOP + PURSE.height - COIN, rise: 4 };
const stackY = (n: number) => STACK.y - n * STACK.rise;
const BANK = { x: STAGE.width - MARK - 10, y: 9 };
const BANK_COIN = { x: BANK.x + (MARK - COIN) / 2, y: BANK.y + (MARK - COIN) / 2 };
const COIN_TRIP_MS = 600;
/** Where houses stand on a band, in the order they are built. */
const HOUSE_SHIFTS = [0, -18, 18].slice(0, MAX_HOUSES);
/** The mortgaged deed rises from its square, then rests — half size — beside the bank that holds it. */
const PLEDGE_FROM = { x: tileX(RIVAL_INDEX) + 19, y: 40 };
const PLEDGE_AT = { x: BANK.x - 58, y: -11, scale: 0.5 };
/** The deed under the hammer, in the middle of the table. */
const LOT = { x: 146, y: 8 };
const RENT_TAG = { width: 66, x: tileX(DESTINATION_INDEX) + TILE.width - 66, y: TILE.top - TAG.height - 8 };
const INSURED_TAG = { width: 84, x: tileX(DESTINATION_INDEX) + TILE.width - 84, y: RENT_TAG.y - TAG.height - 3 };

/** A coin dropping onto a pile: it falls, and settles with one small bounce. */
function land(at: number, y: number): Move[] {
  return [
    [at, at + 260, y, ease.in],
    [at + 260, at + 340, y - 4, ease.out],
    [at + 340, at + 430, y, ease.in],
  ];
}

/** A quick swell and back, for a figure that has just changed. */
function swell(times: readonly number[]): Move[] {
  return times.flatMap((at): Move[] => [
    [at, at + 120, 1.12],
    [at + 120, at + 300, 1, ease.inOut],
  ]);
}

/** A label whose wording changes at given moments: each cross-fades into the next, and the last one stays. */
function Ticker({ scene, labels, times }: { scene: Scene; labels: readonly string[]; times: readonly number[] }) {
  return (
    <>
      {labels.map((label, i) => {
        const moves: Move[] = [];
        if (i > 0) moves.push([times[i - 1]!, times[i - 1]! + 120, 1, ease.linear]);
        if (i < labels.length - 1) moves.push([times[i]!, times[i]! + 120, 0, ease.linear]);
        return (
          <Animated.View key={label} style={{ position: 'absolute', opacity: scene.num(i === 0 ? 1 : 0, moves) }}>
            <TagText>{label}</TagText>
          </Animated.View>
        );
      })}
    </>
  );
}

/** Money moving into or out of the purse, shown for a moment and then gone. */
function Passing({ scene, value, at }: { scene: Scene; value: number; at: number }) {
  return (
    <Animated.View style={{ position: 'absolute', opacity: scene.num(0, [[at, at + 250, 1], [at + 900, at + 1150, 0, ease.linear]]) }}>
      <Amount value={value} />
    </Animated.View>
  );
}

const TycoonScene = memo(function TycoonScene() {
  const scene = useScene(TYCOON_MS);

  // B — houses, then a hotel; the rent on the deed climbs with each.
  const builds = [1500, 1750];
  const hotelAt = 2250;
  const rentSteps = [...builds.map((at) => at + 100), hotelAt + 100];
  // C — a deed goes to the bank and cash comes back; the developed property is insured.
  const pledgeAt = 3050;
  const pledged = pledgeAt + 1050;
  const borrowed = [pledged + 50, pledged + 200];
  const insuredAt = 4500;
  // D — two rivals close in on the last free square; it is auctioned and the owner outbids them.
  const thirdMove = walk(5000, tokenSpot(RIVAL_INDEX), tokenSpot(AUCTION_INDEX, SHARE), AUCTION_INDEX - RIVAL_INDEX);
  const rivalMove = walk(5100, tokenSpot(0), tokenSpot(AUCTION_INDEX, -SHARE), AUCTION_INDEX);
  const lotAt = 5200;
  const raises = [5950, 6400];
  const soldAt = 6900;
  const paid = [soldAt + 100, soldAt + 250];
  // E — everything settles: one last coin, a cheer, and the picture holds.
  const cheerAt = 7950;

  const rivalTo = tokenSpot(AUCTION_INDEX, -SHARE);
  const thirdTo = tokenSpot(AUCTION_INDEX, SHARE);
  const ownerAt = tokenSpot(DESTINATION_INDEX);
  /** A coin on its way between the bank and the pile: up and over, never straight through the table. */
  const trip = (at: number, from: { x: number; y: number }, to: { x: number; y: number }) => {
    const peak = Math.min(from.y, to.y) - 6;
    return {
      x: [[at, at + COIN_TRIP_MS, to.x, ease.inOut]] satisfies Move[],
      y: [[at, at + COIN_TRIP_MS / 2, peak], [at + COIN_TRIP_MS / 2, at + COIN_TRIP_MS, to.y, ease.in]] satisfies Move[],
    };
  };

  return (
    <Stage scene={scene}>
      <At x={tileX(RIVAL_INDEX)} y={TILE.top + TILE.band} opacity={scene.num(0, [[pledged, pledged + 300, 0.6]])}>
        <MortgageVeil deed={OFFERED} />
      </At>
      <Ownership scene={scene} index={RIVAL_INDEX} seat={OWNER} at={null} />
      <Ownership scene={scene} index={DESTINATION_INDEX} seat={OWNER} at={null} />
      <Ownership scene={scene} index={AUCTION_INDEX} seat={OWNER} at={soldAt + 50} />
      <Glow scene={scene} index={RIVAL_INDEX} at={450} />
      <Glow scene={scene} index={DESTINATION_INDEX} at={600} />
      <Glow scene={scene} index={DESTINATION_INDEX} at={hotelAt + 100} />
      <Glow scene={scene} index={DESTINATION_INDEX} at={cheerAt} />

      {HOUSE_SHIFTS.map((shift, i) => (
        <House key={shift} scene={scene} index={DESTINATION_INDEX} shift={shift} at={i === 0 ? null : builds[i - 1]!} gone={hotelAt} />
      ))}
      <At
        x={tileX(DESTINATION_INDEX) + (TILE.width - HOUSE - 2) / 2}
        y={TILE.top + (TILE.band - HOUSE) / 2}
        opacity={scene.num(0, [[hotelAt + 50, hotelAt + 170, 1, ease.linear]])}
        scale={scene.num(0.3, [[hotelAt + 50, hotelAt + 450, 1, ease.pop]])}
      >
        <HotelPiece />
      </At>
      <At x={tileX(RIVAL_INDEX) + (TILE.width - 12) / 2} y={TILE.top + (TILE.band - 12) / 2} scale={scene.num(0, [[pledged, pledged + 350, 1, ease.pop]])}>
        <MortgageMark />
      </At>

      <At x={scene.num(tokenSpot(RIVAL_INDEX).x, thirdMove.x)} y={scene.num(tokenSpot(RIVAL_INDEX).y, [...thirdMove.y, ...bounce(cheerAt + 270, thirdTo.y, 6)])}>
        <TokenPiece seat={THIRD} />
      </At>
      <At
        x={scene.num(tokenSpot(0).x, [
          ...rivalMove.x,
          // Outbid: a shake of the head.
          [soldAt + 100, soldAt + 180, rivalTo.x - 3, ease.inOut],
          [soldAt + 180, soldAt + 260, rivalTo.x + 3, ease.inOut],
          [soldAt + 260, soldAt + 340, rivalTo.x - 2, ease.inOut],
          [soldAt + 340, soldAt + 420, rivalTo.x, ease.inOut],
        ])}
        y={scene.num(tokenSpot(0).y, [...rivalMove.y, ...bounce(cheerAt + 160, rivalTo.y, 6)])}
      >
        <TokenPiece seat={RIVAL} />
      </At>
      <At x={ownerAt.x} y={scene.num(ownerAt.y, bounce(cheerAt + 50, ownerAt.y, 12))}>
        <TokenPiece seat={OWNER} />
      </At>

      <At x={OWNER_PURSE} y={PURSE_TOP} scale={scene.num(1, swell([borrowed[1]! + COIN_TRIP_MS, cheerAt + 400]))}>
        <Purse seat={OWNER}>
          <Passing scene={scene} value={MORTGAGE_CASH} at={borrowed[1]! + COIN_TRIP_MS - 150} />
          <Passing scene={scene} value={-AUCTION_BIDS[2]} at={paid[0]!} />
        </Purse>
      </At>
      {[700, 950, hotelAt + 400, cheerAt - 50].map((at, n) => (
        <At key={at} x={STACK.x} y={scene.num(stackY(n) - 34, land(at, stackY(n)))} opacity={scene.num(0, [[at, at + 100, 1, ease.linear]])}>
          <Coin />
        </At>
      ))}

      <At x={BANK.x} y={BANK.y} opacity={scene.num(0, [[pledgeAt - 50, pledgeAt + 70, 1, ease.linear]])} scale={scene.num(0.3, [[pledgeAt - 50, pledgeAt + 350, 1, ease.pop]])}>
        <BankMark />
      </At>
      <At
        x={scene.num(PLEDGE_FROM.x, [[pledgeAt + 450, pledged, PLEDGE_AT.x, ease.inOut]])}
        y={scene.num(PLEDGE_FROM.y + 22, [[pledgeAt, pledgeAt + 300, PLEDGE_FROM.y], [pledgeAt + 450, pledged, PLEDGE_AT.y, ease.inOut]])}
        opacity={scene.num(0, [[pledgeAt, pledgeAt + 120, 1, ease.linear]])}
        scale={scene.num(0.3, [[pledgeAt, pledgeAt + 380, 1, ease.pop], [pledgeAt + 450, pledged, PLEDGE_AT.scale, ease.inOut]])}
        rotate={scene.deg(0, [[pledgeAt + 450, pledged, 8, ease.inOut]])}
      >
        <DeedCard deed={OFFERED} seat={OWNER} />
      </At>
      {/* The loan: two coins from the bank to the pile — and, later, the top two go back to pay for the auction. */}
      {borrowed.map((arrives, i) => {
        const rest = { x: STACK.x, y: stackY(3 + i) };
        const leaves = paid[borrowed.length - 1 - i]!;
        const out = trip(arrives, BANK_COIN, rest);
        const back = trip(leaves, rest, BANK_COIN);
        return (
          <At
            key={arrives}
            x={scene.num(BANK_COIN.x, [...out.x, ...back.x])}
            y={scene.num(BANK_COIN.y, [...out.y, ...back.y])}
            opacity={scene.num(0, [[arrives, arrives + 80, 1, ease.linear], [leaves + COIN_TRIP_MS - 80, leaves + COIN_TRIP_MS, 0, ease.linear]])}
          >
            <Coin />
          </At>
        );
      })}

      <At
        x={LOT.x}
        y={scene.num(LOT.y + 22, [[lotAt, lotAt + 300, LOT.y]])}
        opacity={scene.num(0, [[lotAt, lotAt + 120, 1, ease.linear]])}
        scale={scene.num(0.3, [[lotAt, lotAt + 380, 1, ease.pop], ...swell([soldAt])])}
        rotate={scene.deg(0, [[soldAt, soldAt + 300, -5]])}
      >
        <DeedCard deed={AUCTIONED} />
      </At>
      <At
        x={LOT.x}
        y={LOT.y + CARD.height - 6}
        opacity={scene.num(0, [[lotAt + 300, lotAt + 420, 1, ease.linear], [soldAt + 200, soldAt + 400, 0, ease.linear]])}
        scale={scene.num(1, swell(raises))}
      >
        <Tag width={CARD.width}>
          <Ticker scene={scene} labels={AUCTION_BIDS.map(formatINR)} times={raises} />
        </Tag>
      </At>
      <At x={LOT.x - 12} y={LOT.y - 6} opacity={scene.num(0, [[soldAt, soldAt + 100, 1, ease.linear]])} scale={scene.num(0.3, [[soldAt, soldAt + 380, 1, ease.pop]])}>
        <GavelMark />
      </At>
      <At x={LOT.x + CARD.width - 10} y={LOT.y - 4} scale={scene.num(0, [[soldAt + 130, soldAt + 480, 1, ease.pop]])}>
        <OwnerBadge seat={OWNER} />
      </At>

      <At x={RENT_TAG.x} y={RENT_TAG.y} opacity={scene.num(0, [[500, 750, 1]])} scale={scene.num(1, swell(rentSteps))}>
        <Tag width={RENT_TAG.width}>
          <Ticker scene={scene} labels={RENT_LADDER.map((rent) => `${ONBOARDING_LABELS.rent} ${formatINR(rent)}`)} times={rentSteps} />
        </Tag>
      </At>
      <At x={INSURED_TAG.x} y={INSURED_TAG.y} opacity={scene.num(0, [[insuredAt, insuredAt + 100, 1, ease.linear]])} scale={scene.num(0.3, [[insuredAt, insuredAt + 380, 1, ease.pop]])}>
        <Tag width={INSURED_TAG.width}>
          <TagText>{`🛡️ ${INSURANCE_MODE}`}</TagText>
        </Tag>
      </At>

      <Confetti scene={scene} at={cheerAt + 100} />
    </Stage>
  );
});

/** Past this the pieces would look blown up (tablets): the scene stays a board on the table. */
const MAX_SCALE = 1.7;

const SCENES: Record<OnboardingSceneId, ComponentType> = { rivalry: RivalryScene, turn: TurnScene, trade: TradeScene, tycoon: TycoonScene };

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

