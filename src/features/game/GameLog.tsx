
import { memo } from 'react';
import { Text, View } from 'react-native';
import type { GameEventRecord, PlayerState } from '@/engine/index.ts';
import { Label, PlayerBadge } from '@/components/ui';

interface EventStyle {
  icon: string;
  color: string;
  background: string;
}

const PALETTE = {
  ink: '#252820',
  muted: '#77796F',
  border: '#E8E6DE',
  surface: '#FFFFFF',
  subtle: '#F7F6F1',
  green: '#386747',
  greenTint: '#EAF1E9',
  amber: '#8B641F',
  amberTint: '#F7F0DF',
  red: '#A3473E',
  redTint: '#F8EAE7',
  blue: '#496783',
  blueTint: '#EAF0F5',
  neutral: '#696B63',
  neutralTint: '#F0EFEA',
} as const;

const EXACT: Readonly<Record<string, EventStyle>> = {
  PASSED_START: {
    icon: '↗',
    color: PALETTE.green,
    background: PALETTE.greenTint,
  },
  REST_HOUSE: {
    icon: 'Ⅱ',
    color: PALETTE.blue,
    background: PALETTE.blueTint,
  },
  REST_HOUSE_SHORTFALL: {
    icon: 'Ⅱ',
    color: PALETTE.blue,
    background: PALETTE.blueTint,
  },
  SENT_TO_JAIL: {
    icon: '!',
    color: PALETTE.red,
    background: PALETTE.redTint,
  },
  JAIL_RELEASED: {
    icon: '✓',
    color: PALETTE.green,
    background: PALETTE.greenTint,
  },
  PLAYER_BANKRUPT: {
    icon: '−',
    color: PALETTE.red,
    background: PALETTE.redTint,
  },
  PLAYER_JOINED: {
    icon: '+',
    color: PALETTE.neutral,
    background: PALETTE.neutralTint,
  },
  PLAYER_READY: {
    icon: '✓',
    color: PALETTE.green,
    background: PALETTE.greenTint,
  },
  GAME_FINISHED: {
    icon: '★',
    color: PALETTE.amber,
    background: PALETTE.amberTint,
  },
  BID_PLACED: {
    icon: '↑',
    color: PALETTE.amber,
    background: PALETTE.amberTint,
  },
  HOUSE_BUILT: {
    icon: '+',
    color: PALETTE.green,
    background: PALETTE.greenTint,
  },
  HOTEL_BUILT: {
    icon: '+',
    color: PALETTE.green,
    background: PALETTE.greenTint,
  },
  BUILDING_SOLD: {
    icon: '−',
    color: PALETTE.amber,
    background: PALETTE.amberTint,
  },
  LANDED_OWN: {
    icon: '⌂',
    color: PALETTE.green,
    background: PALETTE.greenTint,
  },
  MONEY_TRANSFERRED: {
    icon: '₹',
    color: PALETTE.green,
    background: PALETTE.greenTint,
  },
  PAYMENT_MADE: {
    icon: '₹',
    color: PALETTE.red,
    background: PALETTE.redTint,
  },
  NO_RENT: {
    icon: '₹',
    color: PALETTE.neutral,
    background: PALETTE.neutralTint,
  },
};

const BY_PREFIX: readonly (readonly [string, EventStyle])[] = [
  [
    'AUCTION_',
    {
      icon: '↑',
      color: PALETTE.amber,
      background: PALETTE.amberTint,
    },
  ],
  [
    'TRADE_',
    {
      icon: '⇄',
      color: PALETTE.blue,
      background: PALETTE.blueTint,
    },
  ],
  [
    'UNDO_',
    {
      icon: '↶',
      color: PALETTE.blue,
      background: PALETTE.blueTint,
    },
  ],
  [
    'CARD_',
    {
      icon: '▤',
      color: PALETTE.amber,
      background: PALETTE.amberTint,
    },
  ],
  [
    'JAIL_',
    {
      icon: '!',
      color: PALETTE.red,
      background: PALETTE.redTint,
    },
  ],
  [
    'PROPERTY_',
    {
      icon: '⌂',
      color: PALETTE.green,
      background: PALETTE.greenTint,
    },
  ],
  [
    'LOAN_',
    {
      icon: '₹',
      color: PALETTE.blue,
      background: PALETTE.blueTint,
    },
  ],
  [
    'TAX_',
    {
      icon: '₹',
      color: PALETTE.red,
      background: PALETTE.redTint,
    },
  ],
  [
    'GAME_',
    {
      icon: '•',
      color: PALETTE.neutral,
      background: PALETTE.neutralTint,
    },
  ],
];

const DEFAULT_STYLE: EventStyle = {
  icon: '•',
  color: PALETTE.neutral,
  background: PALETTE.neutralTint,
};

function styleOf(type: string): EventStyle {
  return (
    EXACT[type] ??
    BY_PREFIX.find(([prefix]) => type.startsWith(prefix))?.[1] ??
    DEFAULT_STYLE
  );
}

/** Local wall-clock time of an event, e.g. "9:05 pm". */
function timeOf(iso: string): string | null {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const hours = date.getHours();
  const period = hours < 12 ? 'am' : 'pm';

  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${period}`;
}

interface GameLogProps {
  /** Newest first, as the server sends them. */
  events: GameEventRecord[];
  players: readonly PlayerState[];
  limit?: number;
}

export const GameLog = memo(function GameLog({
  events,
  players,
  limit = 30,
}: GameLogProps) {
  const shown = events.slice(0, limit);

  if (shown.length === 0) {
    return (
      <View
        className="items-center rounded-2xl border border-[#E8E6DE] bg-white px-5 py-9"
        testID="event-feed-empty"
      >
        <View className="mb-3 h-11 w-11 items-center justify-center rounded-full bg-[#F0EFEA]">
          <Text
            className="text-xl font-semibold"
            style={{ color: PALETTE.neutral }}
            allowFontScaling={false}
          >
            —
          </Text>
        </View>

        <Text
          className="text-base font-semibold"
          style={{ color: PALETTE.ink }}
        >
          No activity yet
        </Text>

        <Text
          className="mt-1 text-center text-sm leading-5"
          style={{ color: PALETTE.muted }}
        >
          Rolls, payments and property transactions will appear here.
        </Text>
      </View>
    );
  }

  return (
    <View testID="event-feed">
      <View className="mb-3 flex-row items-center justify-between">
        <Label>Recent activity</Label>

        <Text
          className="text-xs font-medium"
          style={{ color: PALETTE.muted }}
        >
          {shown.length} {shown.length === 1 ? 'event' : 'events'}
        </Text>
      </View>

      <View
        className="overflow-hidden rounded-2xl border border-[#E8E6DE] bg-white"
      >
        {shown.map((event, index) => {
          const style = styleOf(event.type);

          const actor = event.actorId
            ? players.find((player) => player.id === event.actorId)
            : undefined;

          const time = timeOf(event.createdAt);

          return (
            <View
              key={event.id}
              testID={`log-entry-${event.id}`}
              className="flex-row items-start gap-3 px-3.5 py-3"
              style={{
                borderBottomWidth: index < shown.length - 1 ? 1 : 0,
                borderBottomColor: PALETTE.border,
              }}
            >
              <View
                className="mt-0.5 h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                style={{ backgroundColor: style.background }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Text
                  className="text-lg font-semibold"
                  style={{ color: style.color }}
                  allowFontScaling={false}
                >
                  {style.icon}
                </Text>
              </View>

              <View className="min-w-0 flex-1 justify-center">
                <Text
                  className="text-sm font-semibold leading-5"
                  style={{ color: PALETTE.ink }}
                >
                  {event.message}
                </Text>

                {actor || time ? (
                  <View className="mt-1.5 flex-row items-center gap-1.5">
                    {actor ? (
                      <PlayerBadge player={actor} size={14} />
                    ) : null}

                    <Text
                      className="min-w-0 flex-1 text-xs leading-4"
                      style={{ color: PALETTE.muted }}
                      numberOfLines={2}
                    >
                      {[actor?.name, time].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      {events.length > shown.length ? (
        <Text
          className="pt-3 text-center text-xs"
          style={{ color: PALETTE.muted }}
        >
          Showing the latest {shown.length} events
        </Text>
      ) : null}
    </View>
  );
});
