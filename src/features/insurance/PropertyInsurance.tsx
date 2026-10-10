import { useState } from 'react';
import { Text, View } from 'react-native';
import {
  averageSpaces,
  economyOf,
  getDeed,
  INTERMEDIATE_RULES,
  insureBlocker,
  policySpacesLeft,
  propertyInsurance,
  type PropertyKey,
} from '@/engine/index.ts';
import { Button, ConfirmDialog, Label, Pill } from '@/components/ui';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

const INS = INTERMEDIATE_RULES.insurance;

/**
 * The one way a policy is bought: a button that opens a confirmation showing the exact premium,
 * the term and the one-crisis limit, and only then sends the request. The price sent is the price
 * shown; the server charges its own and refuses if the two differ. Nothing on screen changes until
 * the server's answer arrives — a refusal stays in the dialog, and success shows as the new state.
 */
export function InsureButton({ view, propertyKey, size = 'md' }: { view: GameView; propertyKey: PropertyKey; size?: 'md' | 'sm' }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const [ask, setAsk] = useState<{ premium: number; busy: boolean; error: string | null } | null>(null);
  const { state } = view.snapshot;
  const me = view.me;
  const insurance = propertyInsurance(state, propertyKey);
  if (!me || !insurance || state.properties[propertyKey].ownerId !== me.id) return null;

  const deed = getDeed(propertyKey);
  const why = insureBlocker(state, me.id, propertyKey);
  const again = !insurance.active && !!insurance.latest;
  const confirm = async () => {
    if (!ask || ask.busy) return;
    const { premium } = ask;
    setAsk({ premium, busy: true, error: null });
    const res = await send({ type: 'INSURE_PROPERTY', propertyKey, expectedPremium: premium }, { silent: true });
    setAsk(res.ok ? null : { premium, busy: false, error: res.error.message });
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
          accessibilityHint={`Covers one crisis bill for ${INS.coverageSpaces} spaces of average movement`}
          onPress={() => setAsk({ premium: insurance.premium, busy: false, error: null })}
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
        summary={ask ? `Premium ${formatINR(ask.premium)} · Year ${insurance.year}` : undefined}
        message={`Covers this property for ${INS.coverageSpaces} spaces of average movement. If a crisis strikes it in that time, the ${formatINR(INS.crisisBill)} bill is waived.`}
        detail="One crisis only: after a claim the policy is spent. No refund if it is never used, and it does not renew by itself."
        confirmTitle={ask ? `Pay ${formatINR(ask.premium)}` : 'Pay'}
        loading={ask?.busy}
        error={ask?.error}
        testID="insure-dialog"
        onCancel={() => setAsk(null)}
        onConfirm={confirm}
      />
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
 * The deed's insurance section (Intermediate Mode with insurance only — renders nothing otherwise,
 * and nothing for a property the bank still holds). Whether a property is insured is public, like a
 * mortgage; the term of a policy is shown to its owner, who can also buy one here.
 */
export function PropertyInsurance({ view, propertyKey }: { view: GameView; propertyKey: PropertyKey }) {
  const { state } = view.snapshot;
  const eco = economyOf(state);
  const insurance = propertyInsurance(state, propertyKey);
  const prop = state.properties[propertyKey];
  if (!eco || !insurance || prop.ownerId === null) return null;

  const mine = prop.ownerId === view.me?.id;
  const { active, latest } = insurance;
  const ended = !active && latest ? (latest.status === 'CLAIMED' ? 'claimed' : 'expired') : null;
  return (
    <View className="mt-1 gap-2 border-t border-stone-200 pt-4" testID="property-insurance">
      <View className="flex-row items-center justify-between">
        <Label>Insurance</Label>
        <View testID="insurance-status">{active ? <Pill tone="good">Insured</Pill> : <Pill tone="warn">Not insured</Pill>}</View>
      </View>
      {mine ? (
        <View className="rounded-2xl bg-white p-3">
          {active ? (
            <>
              <Line label="Policy" value="Active" testID="insurance-policy-state" />
              <Line label="Cover ends at" value={`${averageSpaces(eco, active.expiryClock)} avg. spaces`} testID="insurance-expiry" />
              <Line label="Cover left" value={`${policySpacesLeft(eco, active)} spaces`} testID="insurance-left" />
              <Line label="Premium paid" value={formatINR(active.premiumPaid)} />
            </>
          ) : (
            <>
              <Line label="Policy" value={ended ? `Last one ${ended}` : 'None'} testID="insurance-policy-state" />
              <Line label={`Premium · Year ${insurance.year}`} value={formatINR(insurance.premium)} testID="insurance-premium" />
              <Line label="Cover lasts" value={`${INS.coverageSpaces} avg. spaces`} />
            </>
          )}
          <Line label="Mortgaged" value={prop.mortgaged ? 'Yes' : 'No'} testID="insurance-mortgaged" />
        </View>
      ) : null}
      <Text className="text-xs text-stone-500">
        A crisis can strike any owned property{prop.mortgaged ? ', mortgaged ones included' : ''}: its owner then owes {formatINR(INS.crisisBill)} at once. A policy waives one such bill and
        changes nothing else about the property.
      </Text>
      <InsureButton view={view} propertyKey={propertyKey} />
    </View>
  );
}
