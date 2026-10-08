import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getDeed, ownedBy, tradeBlocker, tradePropertyBlocker, type GameAction, type PropertyKey } from '@/engine/index.ts';
import { Button, Label, PlayerBadge, Sheet, TextField } from '@/components/ui';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

interface TradeSheetProps {
  visible: boolean;
  onClose: () => void;
  view: GameView;
  send: (a: GameAction, opts?: { successMessage?: string }) => Promise<{ ok: boolean }>;
  /** Preselects the other player (e.g. opened from that player's details). Remount (key) to change it. */
  initialPlayerId?: string | null;
}

const toggle = (keys: PropertyKey[], key: PropertyKey) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
const rupees = (text: string) => {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Build a trade offer: your properties + money ⇄ their properties + money.
 * Nothing changes until the other player accepts; the server re-checks
 * everything on accept and executes the whole exchange atomically.
 */
export function TradeSheet({ visible, onClose, view, send, initialPlayerId = null }: TradeSheetProps) {
  const [to, setTo] = useState<string | null>(initialPlayerId);
  const [give, setGive] = useState<PropertyKey[]>([]);
  const [want, setWant] = useState<PropertyKey[]>([]);
  const [giveMoney, setGiveMoney] = useState('');
  const [wantMoney, setWantMoney] = useState('');
  const pending = useGameStore((s) => s.pendingAction);
  const me = view.me;
  const { state } = view.snapshot;

  const draft = useMemo(
    () =>
      me && to
        ? {
            fromPlayerId: me.id,
            toPlayerId: to,
            offeredPropertyKeys: give,
            requestedPropertyKeys: want,
            offeredMoney: rupees(giveMoney),
            requestedMoney: rupees(wantMoney),
          }
        : null,
    [me, to, give, want, giveMoney, wantMoney],
  );
  if (!me) return null;
  const others = state.players.filter((p) => p.id !== me.id && p.status === 'ACTIVE');
  const problem = draft ? tradeBlocker(state, draft) : 'Choose a player to trade with.';

  const reset = () => {
    setGive([]);
    setWant([]);
    setGiveMoney('');
    setWantMoney('');
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="Propose a trade" testID="trade-sheet">
      <Label className="text-stone-600">Trade with</Label>
      <View className="flex-row flex-wrap gap-2">
        {others.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => {
              setTo(p.id);
              setWant([]);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: to === p.id }}
            testID={`trade-with-${p.name}`}
            className={`min-h-[48px] min-w-[45%] flex-1 items-center justify-center rounded-2xl px-4 ${to === p.id ? 'bg-saffron' : 'bg-stone-200'}`}
          >
            <View className="flex-row items-center gap-2">
              <PlayerBadge player={p} size={20} />
              <Text className="text-lg font-bold text-ink" numberOfLines={1}>
                {p.name}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>

      <PropertyPicker title="You give" ownerId={me.id} view={view} selected={give} onToggle={(k) => setGive((g) => toggle(g, k))} testID="trade-give" />
      <View className="rounded-2xl bg-felt p-3">
        <TextField label="Plus money you give (₹)" keyboardType="number-pad" value={giveMoney} onChangeText={setGiveMoney} testID="trade-give-money" />
      </View>

      {to ? (
        <>
          <PropertyPicker
            title={`You get from ${view.playerName(to)}`}
            ownerId={to}
            view={view}
            selected={want}
            onToggle={(k) => setWant((w) => toggle(w, k))}
            testID="trade-want"
          />
          <View className="rounded-2xl bg-felt p-3">
            <TextField label="Plus money you get (₹)" keyboardType="number-pad" value={wantMoney} onChangeText={setWantMoney} testID="trade-want-money" />
          </View>
        </>
      ) : null}

      {problem && to ? (
        <Text className="text-center text-sm font-semibold text-brick" testID="trade-problem">
          {problem}
        </Text>
      ) : null}
      <Button
        title={to ? `SEND OFFER TO ${view.playerName(to).toUpperCase()}` : 'Choose a player'}
        testID="trade-send"
        disabled={!!problem || !!pending}
        loading={pending === 'CREATE_TRADE'}
        onPress={async () => {
          if (!draft) return;
          const { fromPlayerId: _from, ...rest } = draft;
          const res = await send({ type: 'CREATE_TRADE', ...rest }, { successMessage: `Offer sent to ${view.playerName(draft.toPlayerId)}` });
          if (res.ok) {
            reset();
            onClose();
          }
        }}
      />
    </Sheet>
  );
}

function PropertyPicker({
  title,
  ownerId,
  view,
  selected,
  onToggle,
  testID,
}: {
  title: string;
  ownerId: string;
  view: GameView;
  selected: PropertyKey[];
  onToggle: (key: PropertyKey) => void;
  testID: string;
}) {
  const { state } = view.snapshot;
  const keys = ownedBy(state, ownerId);
  return (
    <View className="gap-2" testID={testID}>
      <Label className="text-stone-600">{title}</Label>
      {keys.length === 0 ? <Text className="text-sm text-stone-500">No properties.</Text> : null}
      <View className="flex-row flex-wrap gap-2">
        {keys.map((key) => {
          const deed = getDeed(key);
          const blocked = tradePropertyBlocker(state, ownerId, key);
          const on = selected.includes(key);
          return (
            <Pressable
              key={key}
              disabled={!!blocked}
              onPress={() => onToggle(key)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: !!blocked }}
              accessibilityLabel={`${deed.name}${blocked ? `, ${blocked}` : ''}`}
              testID={`${testID}-${key}`}
              className={`min-h-[44px] flex-row items-center gap-2 rounded-xl px-3 ${on ? 'bg-saffron' : 'bg-white'} ${blocked ? 'opacity-40' : ''}`}
            >
              <View style={{ backgroundColor: PROPERTY_GROUP_THEME[deed.group].mark }} className="h-3 w-3 rounded-full" />
              <Text className="text-base font-bold text-ink">
                {deed.name}
                {state.properties[key].mortgaged ? ' (M)' : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** One line summary: "Mumbai + ₹2,000". */
export function describeTradeSide(keys: PropertyKey[], money: number): string {
  const parts = keys.map((k) => getDeed(k).name);
  if (money > 0) parts.push(formatINR(money));
  return parts.length ? parts.join(' + ') : 'nothing';
}
