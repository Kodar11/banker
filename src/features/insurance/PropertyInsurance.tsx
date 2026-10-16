import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  averageSpaces,
  canSeeFinances,
  coverageLength,
  economyOf,
  gameClock,
  getDeed,
  INTERMEDIATE_RULES,
  insuranceQuote,
  insureBlocker,
  policySpacesLeft,
  propertyInsurance,
  remainingCover,
  type PremiumBreakdown,
  type PropertyKey,
} from '@/engine/index.ts';
import { Button, ConfirmDialog, Label, Pill } from '@/components/ui';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { PolicyTerms } from './PolicyTerms';

const INS = INTERMEDIATE_RULES.insurance;

/**
 * The one way a single-property policy is bought: a button that opens a confirmation showing the exact
 * premium and the policy's terms, and only then sends the request. The price sent is the price shown; the
 * server charges its own and refuses if the two differ. Nothing on screen changes until the server's answer
 * arrives — a refusal stays in the dialog, and success shows as the new state.
 */
export function InsureButton({ view, propertyKey, size = 'md' }: { view: GameView; propertyKey: PropertyKey; size?: 'md' | 'sm' }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const [ask, setAsk] = useState<{ pricing: PremiumBreakdown; busy: boolean; error: string | null } | null>(null);
  const { state } = view.snapshot;
  const me = view.me;
  const eco = economyOf(state);
  const insurance = propertyInsurance(state, propertyKey);
  if (!me || !eco || !insurance || state.properties[propertyKey].ownerId !== me.id) return null;

  const deed = getDeed(propertyKey);
  const why = insureBlocker(state, me.id, propertyKey);
  const again = !insurance.active && !!insurance.latest;
  const clock = gameClock(eco);
  const confirm = async () => {
    if (!ask || ask.busy) return;
    const { pricing } = ask;
    setAsk({ pricing, busy: true, error: null });
    const res = await send({ type: 'INSURE_PROPERTY', propertyKey, expectedPremium: pricing.premium }, { silent: true });
    setAsk(res.ok ? null : { pricing, busy: false, error: res.error.message });
  };

  return (
    <View className="gap-1">
      {insurance.active ? null : (
        <Button
          title={`${again ? 'Insure again' : 'Insure property'} · ${formatINR(insurance.premium)}`}
          size={size}
          variant="primary"
          testID={`insure-${propertyKey}`}
          disabled={!!why || !!pending}
          accessibilityHint={`Pays crisis bills on it for ${INS.coverageSpaces} spaces of average movement, up to ${formatINR(INS.payoutLimit)}`}
          onPress={() => setAsk({ pricing: insuranceQuote({ year: eco.year, properties: 1 }), busy: false, error: null })}
        />
      )}
      {why && !insurance.active ? (
        <Text className="text-center text-xs font-semibold text-stone-600" testID={`insure-note-${propertyKey}`}>
          {why}
        </Text>
      ) : null}
      <ConfirmDialog
        visible={!!ask}
        icon="🛡️"
        title={`Insure ${deed.name}?`}
        summary={ask ? `Premium ${formatINR(ask.pricing.premium)} · Year ${insurance.year}` : undefined}
        message={`If a crisis strikes ${deed.name} in the next ${INS.coverageSpaces} spaces of average movement, the policy pays the bill — every crisis, up to ${formatINR(INS.payoutLimit)} in total.`}
        confirmTitle={ask ? `Pay ${formatINR(ask.pricing.premium)}` : 'Pay'}
        loading={ask?.busy}
        error={ask?.error}
        testID="insure-dialog"
        onCancel={() => setAsk(null)}
        onConfirm={confirm}
      >
        {ask ? <PolicyTerms eco={eco} pricing={ask.pricing} startClock={clock} expiryClock={clock + coverageLength(eco)} /> : null}
      </ConfirmDialog>
    </View>
  );
}

function Line({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3 py-0.5" testID={testID}>
      <Text className="flex-1 text-sm text-stone-600">{label}</Text>
      <Text className="text-right text-base font-bold text-ink">{value}</Text>
    </View>
  );
}

/**
 * The deed's insurance section (Capital Mode with insurance only — renders nothing otherwise,
 * and nothing for a property the bank still holds). Whether a property is insured is public, like a
 * mortgage; the terms of a policy are shown to its owner, who can also buy one here.
 */
export function PropertyInsurance({ view, propertyKey }: { view: GameView; propertyKey: PropertyKey }) {
  const { state } = view.snapshot;
  const eco = economyOf(state);
  const insurance = propertyInsurance(state, propertyKey);
  const prop = state.properties[propertyKey];
  if (!eco || !insurance || prop.ownerId === null) return null;

  const mine = prop.ownerId === view.me?.id;
  // Hidden finances: whether another player's property is insured is theirs to know (this phone is not sent it).
  const known = canSeeFinances(state, view.me?.id, prop.ownerId);
  const { active, latest } = insurance;
  const ended = !active && latest ? (latest.status === 'CLAIMED' ? 'claimed' : latest.status === 'ACTIVE' ? 'renewal booked' : 'expired') : null;
  return (
    <View className="mt-1 gap-2 border-t border-stone-200 pt-4" testID="property-insurance">
      <View className="flex-row items-center justify-between">
        <Label>Insurance</Label>
        <View testID="insurance-status">{!known ? <Pill>Private</Pill> : active ? <Pill tone="good">Insured</Pill> : <Pill tone="warn">Not insured</Pill>}</View>
      </View>
      {mine ? (
        <View className="rounded-2xl bg-white p-3">
          {active ? (
            <>
              <Line label="Policy" value={active.boughtKeys.length > 1 ? `Active · portfolio of ${active.propertyKeys.length}` : 'Active'} testID="insurance-policy-state" />
              <Line label="Cover ends at" value={`${averageSpaces(eco, active.expiryClock)} avg. spaces`} testID="insurance-expiry" />
              <Line label="Cover left" value={`${policySpacesLeft(eco, active)} spaces`} testID="insurance-left" />
              <Line label="Payout left this period" value={`${formatINR(remainingCover(active))} of ${formatINR(active.payoutLimit)}`} testID="insurance-remaining" />
              <Line label="Premium paid" value={formatINR(active.premiumPaid)} />
            </>
          ) : (
            <>
              <Line label="Policy" value={ended ? `Last one ${ended}` : 'None'} testID="insurance-policy-state" />
              <Line label={`Premium · Year ${insurance.year}`} value={formatINR(insurance.premium)} testID="insurance-premium" />
              <Line label="Cover lasts" value={`${INS.coverageSpaces} avg. spaces`} />
              <Line label="Pays up to" value={`${formatINR(INS.payoutLimit)} per period`} />
            </>
          )}
          <Line label="Mortgaged" value={prop.mortgaged ? 'Yes' : 'No'} testID="insurance-mortgaged" />
        </View>
      ) : null}
      <Text className="text-xs text-stone-500">
        A crisis can strike any owned property{prop.mortgaged ? ', mortgaged ones included' : ''}: its owner then owes {formatINR(INS.crisisBill)} at once. A policy pays such bills
        automatically, up to its limit, and changes nothing else about the property. It does not pass to a new owner.
      </Text>
      <InsureButton view={view} propertyKey={propertyKey} />
    </View>
  );
}
