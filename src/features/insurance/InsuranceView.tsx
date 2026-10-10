import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  activePolicyFor,
  averageSpaces,
  economyOf,
  gameClock,
  getDeed,
  insureAllBlocker,
  INTERMEDIATE_RULES,
  nextCrisisClock,
  ownedBy,
  policySpacesLeft,
  policyStanding,
  premiumForYear,
  PROPERTY_KEYS,
  uninsuredProperties,
  type CrisisRecord,
  type InsurancePolicy,
  type IntermediateState,
} from '@/engine/index.ts';
import { Button, Card, ConfirmDialog, Label, Pill, Screen } from '@/components/ui';
import { useGameAction } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';
import { goBack, openProperty } from '@/utils/navigation';
import { InsureButton } from './PropertyInsurance';

const INS = INTERMEDIATE_RULES.insurance;

function Row({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3 py-0.5" testID={testID}>
      <Text className="flex-1 text-sm text-stone-600">{label}</Text>
      <Text className="text-right text-sm font-bold text-ink">{value}</Text>
    </View>
  );
}

function Section({ title, count, children, testID }: { title: string; count: number; children: ReactNode; testID: string }) {
  return (
    <View className="gap-2" testID={testID}>
      <Label>
        {title} · {count}
      </Label>
      {children}
    </View>
  );
}

function PolicyCard({ view, eco, policy }: { view: GameView; eco: IntermediateState; policy: InsurancePolicy }) {
  const standing = policyStanding(view.snapshot.state, policy);
  return (
    <View className="rounded-2xl bg-white p-3" testID={`policy-${policy.id}`}>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-base font-extrabold text-ink">{getDeed(policy.propertyKey).name}</Text>
        {standing === 'IN_FORCE' ? (
          <Pill tone="good">Active</Pill>
        ) : standing === 'NOT_OWNED' ? (
          <Pill tone="warn">Not in force</Pill>
        ) : standing === 'CLAIMED' ? (
          <Pill tone="gold">Claimed</Pill>
        ) : (
          <Pill>Expired</Pill>
        )}
      </View>
      <Row label="Owner" value={view.playerName(policy.ownerId)} />
      <Row label={`Premium paid · Year ${policy.purchaseYear}`} value={formatINR(policy.premiumPaid)} />
      <Row label="Cover from" value={`${averageSpaces(eco, policy.startClock)} avg. spaces`} />
      <Row label="Cover until" value={`${averageSpaces(eco, policy.expiryClock)} avg. spaces`} />
      {standing === 'IN_FORCE' ? <Row label="Cover left" value={`${policySpacesLeft(eco, policy)} spaces`} /> : null}
      <Row label="Claimed" value={policy.status === 'CLAIMED' ? 'Yes — it waived one crisis bill' : 'No'} />
      {standing === 'NOT_OWNED' ? (
        <Text className="mt-1 text-xs font-semibold text-amber-800">You no longer own this property, so this policy protects nothing. It does not pass to the new owner.</Text>
      ) : null}
    </View>
  );
}

/**
 * "Insure all": one confirmation, one request, for every property of mine that nothing protects.
 * The server insures all of them or none; a refusal stays in the dialog.
 */
function InsureAll({ view }: { view: GameView }) {
  const send = useGameAction();
  const pending = useGameStore((s) => s.pendingAction);
  const [ask, setAsk] = useState<{ keys: ReturnType<typeof uninsuredProperties>; premium: number; busy: boolean; error: string | null } | null>(null);
  const { state } = view.snapshot;
  const eco = economyOf(state);
  const me = view.me;
  if (!eco || !me) return null;
  const keys = uninsuredProperties(state, me.id);
  // One property is insured from its own row; this is for the rest of the list at once.
  if (keys.length < 2) return null;
  const premium = premiumForYear(eco.year);
  const why = insureAllBlocker(state, me.id, keys);
  const confirm = async () => {
    if (!ask || ask.busy) return;
    setAsk({ ...ask, busy: true, error: null });
    const res = await send({ type: 'INSURE_PROPERTIES', propertyKeys: ask.keys, expectedPremium: ask.premium }, { silent: true });
    setAsk(res.ok ? null : { ...ask, busy: false, error: res.error.message });
  };
  return (
    <View className="gap-1" testID="insure-all">
      <Button
        title={`Insure all ${keys.length} · ${formatINR(keys.length * premium)}`}
        size="md"
        testID="insure-all-button"
        disabled={!!why || !!pending}
        accessibilityHint={`${formatINR(premium)} for each property that is not insured`}
        onPress={() => setAsk({ keys, premium, busy: false, error: null })}
      />
      {why ? (
        <Text className="text-center text-xs font-semibold text-stone-600" testID="insure-all-note">
          {why}
        </Text>
      ) : null}
      <ConfirmDialog
        visible={!!ask}
        icon="🛡️"
        title={ask ? `Insure ${ask.keys.length} properties?` : 'Insure all?'}
        summary={ask ? `${ask.keys.length} × ${formatINR(ask.premium)} = ${formatINR(ask.keys.length * ask.premium)} · Year ${eco.year}` : undefined}
        message={ask ? ask.keys.map((k) => getDeed(k).name).join(', ') : ''}
        detail={`Each gets its own policy: ${INS.coverageSpaces} spaces of average movement, one crisis bill waived, no refund and no automatic renewal.`}
        confirmTitle={ask ? `Pay ${formatINR(ask.keys.length * ask.premium)}` : 'Pay'}
        loading={ask?.busy}
        error={ask?.error}
        testID="insure-all-dialog"
        onCancel={() => setAsk(null)}
        onConfirm={confirm}
      />
    </View>
  );
}

const OUTCOME: Record<CrisisRecord['status'], string> = {
  SKIPPED: 'Nobody owned a property',
  COVERED: 'Insured — bill waived',
  PENDING: 'Bill pending',
  PAID: 'Bill paid',
  BANKRUPT: 'Owner went bankrupt',
  UNPAID: 'Not paid in full',
};

/**
 * More → Property Insurance: this year's premium, my properties with what protects them, my
 * policies by status, what the table can see of everyone else's, and the crises so far.
 * Read from the server's snapshot; the only thing it can send is a purchase request.
 */
export function InsuranceView({ view }: { view: GameView }) {
  const { state } = view.snapshot;
  const eco = economyOf(state);
  const insurance = eco?.insurance;
  const me = view.me;
  const back = () => goBack(`/game/${state.id}`);

  if (!eco || !insurance) {
    return (
      <Screen scroll testID="insurance-screen">
        <Button size="sm" variant="ghost" title="‹ Back" onPress={back} className="self-start" />
        <Card testID="insurance-unavailable">
          <Text className="text-2xl font-black text-ink">Property Insurance</Text>
          <Text className="mt-2 text-base text-stone-700">Property insurance is part of Intermediate Mode. This game is played without it.</Text>
        </Card>
      </Screen>
    );
  }

  const clock = gameClock(eco);
  const premium = premiumForYear(eco.year);
  const next = nextCrisisClock(eco);
  const myKeys = me ? ownedBy(state, me.id) : [];
  const myPolicies = me ? insurance.policies.filter((p) => p.ownerId === me.id) : [];
  const standingOf = (p: InsurancePolicy) => policyStanding(state, p);
  const active = myPolicies.filter((p) => standingOf(p) === 'IN_FORCE' || standingOf(p) === 'NOT_OWNED');
  const claimed = myPolicies.filter((p) => standingOf(p) === 'CLAIMED');
  const expired = myPolicies.filter((p) => standingOf(p) === 'EXPIRED');
  const others = PROPERTY_KEYS.filter((k) => {
    const owner = state.properties[k].ownerId;
    return owner !== null && owner !== me?.id;
  });
  const crises = [...insurance.crises].reverse();

  return (
    <Screen scroll testID="insurance-screen">
      <Button size="sm" variant="ghost" title="‹ Back" onPress={back} className="self-start" />

      <Card testID="insurance-summary">
        <Label>Property Insurance</Label>
        <View className="mt-1 flex-row items-end justify-between gap-3">
          <View>
            <Text className="text-xs font-bold uppercase tracking-wider text-stone-500">Financial year</Text>
            <Text className="text-2xl font-black text-ink" testID="insurance-year">
              Year {eco.year}
            </Text>
          </View>
          <View className="items-end">
            <Text className="text-xs font-bold uppercase tracking-wider text-stone-500">Premium per property</Text>
            <Text className="text-2xl font-black text-ink" testID="insurance-current-premium">
              {formatINR(premium)}
            </Text>
          </View>
        </View>
        <Text className="mt-3 text-sm text-stone-700" testID="insurance-explainer">
          Every {INS.crisisIntervalSpaces} spaces of average movement (the first after {INS.firstCrisisSpaces}) a crisis strikes one owned property, picked at random across all players. Its
          owner owes {formatINR(INS.crisisBill)} at once, and the game waits until it is paid. A policy on that property waives the bill — one crisis only — and lasts{' '}
          {INS.coverageSpaces} spaces of average movement. It is never renewed or refunded automatically.
        </Text>
        <View className="mt-3 rounded-2xl bg-white p-3">
          <Row label="Average spaces moved so far" value={String(averageSpaces(eco, clock))} testID="insurance-clock" />
          {next !== null ? <Row label="Next crisis at" value={`${averageSpaces(eco, next)} avg. spaces`} testID="insurance-next-crisis" /> : null}
          <Row label="Premium next year" value={formatINR(premiumForYear(eco.year + 1))} />
        </View>
      </Card>

      <Card testID="insurance-my-properties">
        <Label>Your properties</Label>
        {myKeys.length === 0 ? (
          <View className="mt-2 gap-3" testID="insurance-empty">
            <Text className="text-base text-stone-700">
              You don’t own a property yet, so there is nothing to insure. Buy one when you land on it; you can then insure it here or from its title deed.
            </Text>
            <Button size="md" variant="secondary" title="Back to the board" testID="insurance-to-board" onPress={back} />
          </View>
        ) : (
          <View className="mt-2 gap-3">
            <InsureAll view={view} />
            {myKeys.map((key) => {
              const policy = activePolicyFor(state, key);
              const mortgaged = state.properties[key].mortgaged;
              return (
                <View key={key} className="gap-2 rounded-2xl bg-white p-3" testID={`insurance-property-${key}`}>
                  <Pressable onPress={() => openProperty(key)} accessibilityRole="button" accessibilityLabel={`${getDeed(key).name}. Open title deed`} className="min-h-[44px] flex-row items-center justify-between gap-2">
                    <View className="flex-1">
                      <Text className="text-base font-extrabold text-ink">{getDeed(key).name}</Text>
                      <Text className="text-xs font-semibold text-stone-500">
                        {policy ? `Covered for ${policySpacesLeft(eco, policy)} more spaces` : `Not insured · ${formatINR(INS.crisisBill)} at risk`}
                        {mortgaged ? ' · Mortgaged' : ''}
                      </Text>
                    </View>
                    {policy ? <Pill tone="good">Insured</Pill> : <Pill tone="warn">Not insured</Pill>}
                  </Pressable>
                  <InsureButton view={view} propertyKey={key} size="sm" />
                </View>
              );
            })}
          </View>
        )}
      </Card>

      <Card testID="insurance-my-policies">
        <Label>Your policies</Label>
        {myPolicies.length === 0 ? (
          <Text className="mt-2 text-sm text-stone-600" testID="insurance-no-policies">
            No policies yet.
          </Text>
        ) : (
          <View className="mt-2 gap-4">
            <Section title="Active" count={active.length} testID="policies-active">
              {active.map((p) => (
                <PolicyCard key={p.id} view={view} eco={eco} policy={p} />
              ))}
            </Section>
            <Section title="Claimed" count={claimed.length} testID="policies-claimed">
              {claimed.map((p) => (
                <PolicyCard key={p.id} view={view} eco={eco} policy={p} />
              ))}
            </Section>
            <Section title="Expired" count={expired.length} testID="policies-expired">
              {expired.map((p) => (
                <PolicyCard key={p.id} view={view} eco={eco} policy={p} />
              ))}
            </Section>
          </View>
        )}
      </Card>

      {others.length ? (
        <Card testID="insurance-others">
          <Label>Other players’ properties</Label>
          <View className="mt-2 gap-1">
            {others.map((key) => (
              <View key={key} className="flex-row items-center justify-between gap-2 rounded-xl bg-white px-3 py-2" testID={`insurance-other-${key}`}>
                <Text className="flex-1 text-sm font-bold text-ink">
                  {getDeed(key).name} · {view.playerName(state.properties[key].ownerId)}
                </Text>
                <Text className={`text-xs font-extrabold ${activePolicyFor(state, key) ? 'text-green-700' : 'text-amber-800'}`}>{activePolicyFor(state, key) ? 'Insured' : 'Not insured'}</Text>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      <Card testID="insurance-crises">
        <Label>Crises so far</Label>
        {crises.length === 0 ? (
          <Text className="mt-2 text-sm text-stone-600">None yet.</Text>
        ) : (
          <View className="mt-2 gap-1">
            {crises.map((c) => (
              <View key={c.id} className="rounded-xl bg-white px-3 py-2" testID={`crisis-row-${c.checkpoint}`}>
                <Text className="text-sm font-bold text-ink">
                  {averageSpaces(eco, c.checkpointClock)} avg. spaces · {c.propertyKey ? `${getDeed(c.propertyKey).name} (${view.playerName(c.ownerId)})` : 'No property struck'}
                </Text>
                <Text className={`text-xs font-semibold ${c.status === 'PENDING' ? 'text-brick' : 'text-stone-600'}`}>
                  {OUTCOME[c.status]}
                  {c.propertyKey && c.status !== 'COVERED' ? ` · ${formatINR(c.amount)}` : ''}
                </Text>
              </View>
            ))}
          </View>
        )}
      </Card>
    </Screen>
  );
}
