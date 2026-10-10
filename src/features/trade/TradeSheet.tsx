import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { buildingLabel, getDeed, ownedBy, tradeBlocker, tradePropertyBlocker, tradePropertyLabel, unmortgageCost, type GameAction, type GameState, type PropertyKey } from '@/engine/index.ts';
import { Button, MoneyField, PlayerPicker, Sheet } from '@/components/ui';
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
  // The engine decides whether the offer can be sent; the sheet only chooses how to say what is still missing.
  const problem = draft ? tradeBlocker(state, draft) : 'Choose a player to trade with.';
  const untouched = !!draft && give.length + want.length === 0 && draft.offeredMoney === 0 && draft.requestedMoney === 0;
  /** A form that is simply not filled in yet gets guidance; a real obstacle (e.g. not enough money) reads as one. */
  const unfinished =
    !!draft && (give.length + want.length === 0 || (give.length === 0 && draft.offeredMoney === 0) || (want.length === 0 && draft.requestedMoney === 0));
  const helper = !problem || !to ? null : give.length + want.length === 0 ? 'Add at least one property to the trade.' : problem;
  const next = !to ? 'Choose a player' : !problem ? `Send offer to ${view.playerName(to)}` : untouched ? 'Add something to trade' : 'Complete the trade';

  const reset = () => {
    setGive([]);
    setWant([]);
    setGiveMoney('');
    setWantMoney('');
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Propose a trade"
      testID="trade-sheet"
      footer={
        <View className="gap-2">
          {helper ? (
            <Text className={`text-center text-sm font-semibold ${unfinished ? 'text-stone-600' : 'text-brick'}`} testID="trade-problem">
              {helper}
            </Text>
          ) : null}
          <Button
            title={next}
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
        </View>
      }
    >
      <PlayerPicker
        label="Trade with"
        players={others}
        selectedId={to}
        onSelect={(id) => {
          setTo(id);
          setWant([]);
        }}
        testIDPrefix="trade-with"
      />

      {/* The exchange: what leaves me, then what comes back. Each side keeps its own properties and money together. */}
      <View className="gap-1">
        <TradeSide
          title="You give"
          moneyLabel="Plus money you give"
          ownerId={me.id}
          view={view}
          selected={give}
          onToggle={(k) => setGive((g) => toggle(g, k))}
          money={giveMoney}
          onMoney={setGiveMoney}
          testID="trade-give"
        />
        {to ? (
          <>
            <Text className="text-center text-xl font-black text-stone-400" accessibilityElementsHidden importantForAccessibility="no">
              ⇅
            </Text>
            <TradeSide
              title={`You get from ${view.playerName(to)}`}
              moneyLabel="Plus money you get"
              ownerId={to}
              view={view}
              selected={want}
              onToggle={(k) => setWant((w) => toggle(w, k))}
              money={wantMoney}
              onMoney={setWantMoney}
              testID="trade-want"
            />
          </>
        ) : null}
      </View>
    </Sheet>
  );
}

interface TradeSideProps {
  title: string;
  moneyLabel: string;
  ownerId: string;
  view: GameView;
  selected: PropertyKey[];
  onToggle: (key: PropertyKey) => void;
  money: string;
  onMoney: (digits: string) => void;
  testID: string;
}

/** One side of the exchange: that player's properties to pick from, and the money that goes with them. */
function TradeSide({ title, moneyLabel, ownerId, view, selected, onToggle, money, onMoney, testID }: TradeSideProps) {
  const { state } = view.snapshot;
  const keys = ownedBy(state, ownerId);
  const mortgageNotes = tradeMortgageNotes(state, selected);
  return (
    <View className="gap-3 rounded-2xl bg-felt p-3" testID={testID}>
      <Text className="text-sm font-extrabold uppercase tracking-widest text-cream" numberOfLines={1}>
        {title}
      </Text>
      {keys.length ? (
        <View className="flex-row flex-wrap gap-2">
          {keys.map((key) => {
            const deed = getDeed(key);
            const blocked = tradePropertyBlocker(state, ownerId, key);
            const on = selected.includes(key);
            // What is built here goes with the property: say so on the chip, before it is picked.
            const built = buildingLabel(state.properties[key]);
            return (
              <Pressable
                key={key}
                disabled={!!blocked}
                onPress={() => onToggle(key)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: !!blocked }}
                accessibilityLabel={`${deed.name}${built ? `, with ${built}` : ''}${state.properties[key].mortgaged ? ', mortgaged' : ''}${blocked ? `, ${blocked}` : ''}`}
                testID={`${testID}-${key}`}
                className={`min-h-[44px] flex-row items-center gap-2 rounded-xl border-2 px-3 ${on ? 'border-saffron-dark bg-saffron' : 'border-transparent bg-cream'} ${blocked ? 'opacity-40' : ''}`}
              >
                <View style={{ backgroundColor: PROPERTY_GROUP_THEME[deed.group].mark }} className="h-3.5 w-3.5 rounded-full border border-white" />
                <Text className="text-base font-bold text-ink">
                  {deed.name}
                  {built ? <Text className="font-semibold text-stone-600" testID={`${testID}-${key}-built`}> · {built}</Text> : null}
                  {state.properties[key].mortgaged ? <Text className="font-semibold text-stone-600"> (M)</Text> : null}
                </Text>
                {on ? <Text className="text-base font-black text-ink">✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <View className="rounded-xl border border-dashed border-cream/40 px-3 py-2.5" testID={`${testID}-empty`}>
          <Text className="text-center text-sm font-semibold text-cream/70">No properties available</Text>
        </View>
      )}
      {mortgageNotes.map((note) => (
        <Text key={note} className="text-sm font-semibold text-cream/80" testID={`${testID}-mortgage-note`}>
          {note}
        </Text>
      ))}
      <MoneyField label={moneyLabel} placeholder="0" value={money} onChangeValue={onMoney} testID={`${testID}-money`} />
    </View>
  );
}

/**
 * What changing hands with a mortgage means, one line per mortgaged property: the mortgage goes
 * with it, and this is what its new owner pays to unmortgage (the engine's own figure).
 */
export function tradeMortgageNotes(state: Pick<GameState, 'properties'>, keys: readonly PropertyKey[]): string[] {
  return keys
    .filter((k) => state.properties[k].mortgaged)
    .map((k) => `${getDeed(k).name} is mortgaged and stays mortgaged — ${formatINR(unmortgageCost(k))} to unmortgage.`);
}

/** One line summary: "Mumbai (2 houses) + ₹2,000". Buildings are named when `state` is given — they go with the property. */
export function describeTradeSide(keys: PropertyKey[], money: number, state?: Pick<GameState, 'properties'>): string {
  const parts = keys.map((k) => (state ? tradePropertyLabel(state, k) : getDeed(k).name));
  if (money > 0) parts.push(formatINR(money));
  return parts.length ? parts.join(' + ') : 'nothing';
}
