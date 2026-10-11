import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  activePolicyFor,
  BUSINESS_MVP_RULES,
  buildingLabel,
  getDeed,
  INTERMEDIATE_RULES,
  isIntermediate,
  isPledged,
  openResaleFor,
  ownedBy,
  resaleBlocker,
  reservePriceBlocker,
  type GameState,
  type PropertyKey,
  type PropertyState,
} from '@/engine/index.ts';
import { Button, ConfirmDialog, Label, MoneyField, Pill, Sheet } from '@/components/ui';
import { PROPERTY_GROUP_THEME } from '@/constants/theme';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

/** What goes to the winner along with the deed, in words. The same line wherever a resale is shown. */
export function bundleLabel(prop: Pick<PropertyState, 'houses' | 'hotel'>): string {
  const built = buildingLabel(prop);
  return built ? `Includes ${built === 'hotel' ? 'the hotel' : built}` : 'No buildings';
}

interface ResaleSheetProps {
  view: GameView;
  /** The property being listed; null keeps the sheet closed. */
  propertyKey: PropertyKey | null;
  onClose: () => void;
  /** Where to go once the server has opened the auction. Default: the auction screen, on top of this one. */
  onCreated?: (auctionId: string) => void;
}

/**
 * THE way a resale auction is created, from the auction screen and from every property card:
 * the property and what is built on it, the owner's reserve price, a review of exactly what will
 * be listed, and only then the request. Nothing here is taken as done — the server decides, and a
 * refusal (the property was mortgaged meanwhile, someone else's auction started) stays on screen.
 */
export function ResaleSheet({ view, propertyKey, onClose, onCreated }: ResaleSheetProps) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<{ reserve: number; busy: boolean; error: string | null } | null>(null);
  const { state } = view.snapshot;
  const me = view.me;
  if (!propertyKey || !me) return null;

  const deed = getDeed(propertyKey);
  const prop = state.properties[propertyKey];
  const reserve = amount === '' ? 0 : Number(amount);
  const blocked = resaleBlocker(state, me.id, propertyKey);
  const badPrice = amount === '' ? null : reservePriceBlocker(reserve);
  const insured = activePolicyFor(state, propertyKey)?.ownerId === me.id;
  const close = () => {
    setAmount('');
    setReview(null);
    onClose();
  };
  const confirm = async () => {
    if (!review || review.busy) return;
    const { reserve: reservePrice } = review;
    setReview({ reserve: reservePrice, busy: true, error: null });
    const res = await send({ type: 'START_RESALE_AUCTION', propertyKey, reservePrice }, { silent: true });
    if (!res.ok) {
      setReview({ reserve: reservePrice, busy: false, error: res.error.message });
      return;
    }
    // The server's answer is already in the store: the auction it opened is the one to show.
    const opened = useGameStore.getState().snapshot?.state.auction;
    close();
    if (opened?.status === 'OPEN') (onCreated ?? ((id: string) => router.push(`/auction/${id}`)))(opened.id);
  };
  // The button always says what is still missing, or exactly what it will do. (Why a price is wrong is said at the field.)
  const next = blocked ?? (amount === '' ? 'Enter a reserve price' : badPrice ? 'Enter a valid reserve price' : `Review · reserve ${formatINR(reserve)}`);

  return (
    <Sheet
      visible
      onClose={close}
      title="Auction property"
      testID="resale-sheet"
      footer={
        <Button
          title={next}
          testID="resale-review"
          disabled={!!blocked || amount === '' || !!badPrice || !!pending}
          onPress={() => setReview({ reserve, busy: false, error: null })}
        />
      }
    >
      <View className="overflow-hidden rounded-2xl bg-white" testID="resale-property">
        <View style={{ backgroundColor: PROPERTY_GROUP_THEME[deed.group].color }} className="px-4 py-2">
          <Text style={{ color: PROPERTY_GROUP_THEME[deed.group].onColor }} className="text-xl font-black">
            {deed.name}
          </Text>
        </View>
        <View className="gap-1 px-4 py-3">
          <Text className="text-base font-bold text-ink" testID="resale-bundle">
            {bundleLabel(prop)}
          </Text>
          <Text className="text-sm text-stone-600">
            {prop.hotel || prop.houses > 0
              ? 'Everything built on it is sold with it. The winner pays the bid and nothing more.'
              : 'Sold as it stands, to the highest bidder.'}
          </Text>
        </View>
      </View>
      <View className="gap-3 rounded-2xl bg-felt p-3">
        <MoneyField
          label="Reserve price"
          emphasis="strong"
          value={amount}
          onChangeValue={setAmount}
          placeholder="0"
          error={blocked ? null : badPrice}
          testID="resale-reserve"
        />
      </View>
      {blocked ? (
        <Text className="text-sm font-bold text-brick" accessibilityRole="alert" testID="resale-blocked">
          {blocked}
        </Text>
      ) : null}
      <Text className="text-sm leading-5 text-stone-600">
        Bidding opens at your reserve price, so the first bid already buys it unless someone bids higher. Every other player may bid; you can’t bid on your own property. With no
        bid, nothing changes hands. You can cancel only until the first bid.
      </Text>
      {insured ? (
        <Text className="text-sm leading-5 text-stone-600" testID="resale-insurance-note">
          Your insurance on {deed.name} ends if it sells: no refund, and it does not pass to the buyer.
        </Text>
      ) : null}
      <ConfirmDialog
        visible={!!review}
        icon="🔨"
        title={`Auction ${deed.name}?`}
        summary={review ? `${bundleLabel(prop)} · Reserve ${formatINR(review.reserve)}` : undefined}
        message={`After a ${INTERMEDIATE_RULES.resale.startCountdownSeconds}-second “get ready”, everyone else has ${BUSINESS_MVP_RULES.auction.openingTimerSeconds} seconds to bid, starting at ${review ? formatINR(review.reserve) : 'your reserve'}; each bid restarts the countdown. The highest bid buys it and is paid to you.`}
        detail="Once someone has bid, the auction can’t be cancelled."
        confirmTitle="Start auction"
        intent="warning"
        loading={review?.busy}
        error={review?.error}
        testID="resale-dialog"
        onCancel={() => setReview(null)}
        onConfirm={confirm}
      />
    </Sheet>
  );
}

/**
 * "Auction Property" on a property card (Intermediate Mode, my own property — nothing otherwise).
 * Enabled exactly when the server would accept the listing; when it would not, the reason is said
 * under the button. A property already up for auction shows that, and the way to it, instead.
 */
export function AuctionPropertyAction({ view, propertyKey, quietReason = null }: { view: GameView; propertyKey: PropertyKey; quietReason?: string | null }) {
  const pending = useGameStore((s) => s.pendingAction);
  const [open, setOpen] = useState(false);
  const { state } = view.snapshot;
  const me = view.me;
  if (!me || !isIntermediate(state) || state.properties[propertyKey].ownerId !== me.id) return null;

  const listing = openResaleFor(state, propertyKey);
  if (listing) {
    return (
      <View className="gap-2" testID="property-in-auction">
        <Pill tone="gold">Up for auction</Pill>
        <Button title="View auction" size="md" variant="secondary" testID="action-VIEW_AUCTION" onPress={() => router.push(`/auction/${listing.id}`)} />
      </View>
    );
  }
  const why = resaleBlocker(state, me.id, propertyKey);
  const prop = state.properties[propertyKey];
  const caption = why ? (why === quietReason ? null : why) : prop.hotel || prop.houses > 0 ? `Sold with its ${prop.hotel ? 'hotel' : prop.houses === 1 ? 'house' : 'houses'} to the highest bidder, starting at your reserve.` : 'To the highest bidder, starting at your reserve.';
  return (
    <View className="gap-1">
      <Button title="Auction Property" size="md" variant="secondary" testID="action-AUCTION_PROPERTY" disabled={!!why || !!pending} onPress={() => setOpen(true)} />
      {caption ? (
        <Text className="text-center text-xs font-semibold text-stone-600" testID="action-note-AUCTION_PROPERTY">
          {caption}
        </Text>
      ) : null}
      <ResaleSheet view={view} propertyKey={open ? propertyKey : null} onClose={() => setOpen(false)} />
    </View>
  );
}

/** What a row of the picker says about a property: what is on it, and what holds it back. */
function rowStatus(state: GameState, prop: PropertyState): string {
  const parts = [bundleLabel(prop)];
  if (prop.mortgaged) parts.push('Mortgaged');
  if (isPledged(state, prop.key)) parts.push('Loan collateral');
  return parts.join(' · ');
}

const STEPS = ['Pick a property', 'Set your reserve', 'Highest bid wins'];

/**
 * "Auction my property" on the auction screen: every property I own, with what is built on it and
 * whether it can be listed. Choosing one opens the same reserve-and-review flow as a property card.
 */
export function ResalePicker({ view, onCreated }: { view: GameView; onCreated?: (auctionId: string) => void }) {
  const [picked, setPicked] = useState<PropertyKey | null>(null);
  const { state } = view.snapshot;
  const me = view.me;
  if (!me || !isIntermediate(state)) return null;

  const rows = ownedBy(state, me.id).map((key) => ({ key, prop: state.properties[key], why: resaleBlocker(state, me.id, key) }));
  // One reason for everything (not my turn, an auction is running) is said once, not on every row.
  const shared = rows.length > 0 && rows.every((r) => r.why !== null && r.why === rows[0]!.why) ? rows[0]!.why : null;
  return (
    <View className="gap-4 rounded-3xl bg-cream p-5" testID="resale-picker">
      <View className="gap-1">
        <Label>Sell a property</Label>
        <Text className="text-2xl font-black text-ink">Auction my property</Text>
        <Text className="text-sm leading-5 text-stone-600">Sell a property you own — houses and hotel included — to the other players. Bidding starts at the reserve price you set.</Text>
      </View>
      <View className="flex-row gap-2" testID="resale-steps">
        {STEPS.map((step, i) => (
          <View key={step} className="flex-1 items-center gap-1 rounded-2xl bg-white px-2 py-2.5">
            <View className="h-6 w-6 items-center justify-center rounded-full bg-saffron">
              <Text className="text-xs font-black text-ink">{i + 1}</Text>
            </View>
            <Text className="text-center text-xs font-bold text-stone-700">{step}</Text>
          </View>
        ))}
      </View>
      {rows.length === 0 ? (
        <View className="items-center gap-1 rounded-2xl border border-dashed border-stone-300 px-4 py-5" testID="resale-picker-empty">
          <Text className="text-3xl">🏠</Text>
          <Text className="text-center text-base font-extrabold text-ink">You don’t own a property yet</Text>
          <Text className="text-center text-sm leading-5 text-stone-500">Buy one, or win one at auction, and it will be listed here ready to sell.</Text>
        </View>
      ) : (
        <View className="gap-2">
          <View className="flex-row items-center justify-between">
            <Label>Your properties</Label>
            <View className="min-w-[28px] items-center rounded-full bg-stone-200 px-2 py-0.5" testID="resale-count" accessibilityLabel={`${rows.length} owned`}>
              <Text className="text-xs font-extrabold text-stone-700">{rows.length}</Text>
            </View>
          </View>
          {shared ? (
            <View className="rounded-2xl bg-amber-100 px-3 py-2" testID="resale-picker-blocked">
              <Text className="text-sm font-bold text-amber-800">{shared}</Text>
            </View>
          ) : null}
          {rows.map(({ key, prop, why }) => {
            const deed = getDeed(key);
            return (
              <Pressable
                key={key}
                onPress={() => setPicked(key)}
                disabled={!!why}
                accessibilityRole="button"
                accessibilityLabel={`${deed.name}, ${rowStatus(state, prop)}${why ? `. ${why}` : '. Auction this property'}`}
                accessibilityState={{ disabled: !!why }}
                testID={`resale-pick-${key}`}
                className={`min-h-[56px] flex-row items-center overflow-hidden rounded-2xl bg-white active:opacity-80 ${why ? 'opacity-60' : ''}`}
              >
                <View style={{ backgroundColor: PROPERTY_GROUP_THEME[deed.group].mark }} className="w-1.5 self-stretch" />
                <View className="flex-1 py-2.5 pl-3.5 pr-2">
                  <Text className="text-base font-bold text-ink">{deed.name}</Text>
                  <Text className="text-xs font-semibold text-stone-500" testID={`resale-pick-status-${key}`}>
                    {rowStatus(state, prop)}
                  </Text>
                  {why && why !== shared ? (
                    <Text className="text-xs font-bold text-amber-800" testID={`resale-pick-why-${key}`}>
                      {why}
                    </Text>
                  ) : null}
                </View>
                {why ? null : (
                  <View className="mr-3 rounded-full bg-saffron px-3 py-1">
                    <Text className="text-xs font-extrabold text-ink">Auction ›</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
      <ResaleSheet view={view} propertyKey={picked} onClose={() => setPicked(null)} onCreated={onCreated} />
    </View>
  );
}
