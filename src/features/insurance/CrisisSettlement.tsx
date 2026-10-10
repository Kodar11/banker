import { useState } from 'react';
import { Text, View } from 'react-native';
import { averageSpaces, crisisBankruptcyBlocker, crisisRecoveryOptions, economyOf, getDeed, type CrisisRecord, type GameAction } from '@/engine/index.ts';
import { Button, Card, ConfirmDialog, Label, Pill, Sheet } from '@/components/ui';
import { sendFailure } from '@/features/game/useGameAction';
import type { GameView } from '@/features/game/useGameView';
import { useGameStore } from '@/store/gameStore';
import { formatINR } from '@/utils/currency';

interface CrisisSettlementProps {
  view: GameView;
  /** My pending crisis bill (the server's record of it). */
  crisis: CrisisRecord;
  send: (action: GameAction, opts?: { silent?: boolean }) => Promise<unknown>;
  /** Opens the bank on Borrow. */
  onOpenLoan: () => void;
  /** Opens my properties (mortgage / sell). */
  onOpenProperties: () => void;
  /** Pause, leave, rules. */
  onOpenMore: () => void;
}

/**
 * The table while I owe a crisis bill: it replaces the board and its actions, and it cannot be
 * dismissed. It is drawn from the server's pending crisis record, so reopening the app, losing the
 * connection or opening another screen brings back exactly this — the same bill, the same amount —
 * until the server says it is paid (or the game's bankruptcy rule has run).
 */
export function CrisisSettlement({ view, crisis, send, onOpenLoan, onOpenProperties, onOpenMore }: CrisisSettlementProps) {
  const pending = useGameStore((s) => s.pendingAction);
  const [failure, setFailure] = useState<string | null>(null);
  const [bankruptcy, setBankruptcy] = useState<{ busy: boolean; error: string | null } | null>(null);
  const { state } = view.snapshot;
  const eco = economyOf(state);
  const me = view.me;
  if (!me || !eco || !crisis.propertyKey) return null;

  const deed = getDeed(crisis.propertyKey);
  const due = crisis.amount - crisis.paid;
  const short = due - me.balance;
  const options = crisisRecoveryOptions(state, me.id);
  const bankruptcyBlocked = crisisBankruptcyBlocker(state, me.id, crisis);

  return (
    <View className="gap-3" testID="crisis-settlement" accessibilityViewIsModal>
      <Card className="border-b-4 border-brick">
        <Pill tone="bad">Crisis · payment required</Pill>
        <Text className="mt-2 text-3xl font-black text-ink" accessibilityRole="header">
          Crisis at {deed.name}
        </Text>
        <Text className="text-sm text-stone-600" testID="crisis-checkpoint">
          Checkpoint {crisis.checkpoint} · {averageSpaces(eco, crisis.checkpointClock)} spaces of average movement · Year {crisis.year}
        </Text>
        <View className="mt-3 rounded-2xl bg-white p-3">
          <Label>You owe the bank</Label>
          <Text className="text-4xl font-black text-ink" testID="crisis-amount">
            {formatINR(due)}
          </Text>
          <Text className="mt-1 text-sm font-semibold text-stone-700" testID="crisis-reason">
            {deed.name} was not insured{crisis.mortgaged ? ' (a mortgaged property can be struck too)' : ''}. Nothing else about it changes.
          </Text>
          <Text className="mt-2 text-sm text-stone-700" testID="crisis-cash">
            Your cash: {formatINR(me.balance)}
          </Text>
        </View>
        <Text className="mt-3 text-sm font-bold text-brick" testID="crisis-status">
          Pending — the game waits for everyone until this is settled.
        </Text>
        <Button
          className="mt-3"
          title={`PAY ${formatINR(due)}`}
          testID="crisis-pay"
          loading={pending === 'PAY_CRISIS_BILL'}
          disabled={!!pending || short > 0}
          onPress={async () => {
            setFailure(null);
            setFailure(sendFailure(await send({ type: 'PAY_CRISIS_BILL', crisisId: crisis.id }, { silent: true })));
          }}
        />
        {failure ? (
          <Text className="mt-2 text-center text-sm font-bold text-brick" accessibilityRole="alert" testID="crisis-error">
            {failure}
          </Text>
        ) : null}
        {short > 0 ? (
          <View className="mt-3 gap-3 rounded-2xl bg-red-50 p-3" testID="crisis-recovery">
            <Text className="text-center text-base font-bold text-brick" testID="crisis-short">
              You’re {formatINR(short)} short.
            </Text>
            <Text className="text-center text-sm text-stone-700" testID="crisis-options">
              {options.length ? `You can still: ${options.join(', ')}.` : 'There is nothing left to sell, mortgage or borrow.'}
            </Text>
            <View className="flex-row gap-3">
              <Button className="flex-1" size="sm" variant="secondary" title="Take a loan" testID="crisis-loan" onPress={onOpenLoan} />
              <Button className="flex-1" size="sm" variant="secondary" title="Mortgage / sell" testID="crisis-properties" onPress={onOpenProperties} />
            </View>
            <Button
              size="sm"
              variant="danger"
              title="Declare bankruptcy"
              testID="crisis-bankrupt"
              disabled={!!bankruptcyBlocked || !!pending}
              onPress={() => setBankruptcy({ busy: false, error: null })}
            />
            {bankruptcyBlocked ? (
              <Text className="text-center text-xs font-semibold text-stone-600" testID="crisis-bankrupt-note">
                {bankruptcyBlocked}
              </Text>
            ) : null}
          </View>
        ) : null}
      </Card>
      <Button size="sm" variant="ghost" title="Pause, leave or rules" testID="crisis-more" onPress={onOpenMore} />
      <ConfirmDialog
        visible={!!bankruptcy}
        title="Declare bankruptcy?"
        message="Your cash goes to the bank and your properties return to it."
        detail="You leave the game. This can’t be taken back."
        confirmTitle="Declare"
        destructive
        loading={bankruptcy?.busy}
        error={bankruptcy?.error}
        testID="crisis-bankrupt-dialog"
        onCancel={() => setBankruptcy(null)}
        onConfirm={async () => {
          if (bankruptcy?.busy) return;
          setBankruptcy({ busy: true, error: null });
          const error = sendFailure(await send({ type: 'DECLARE_CRISIS_BANKRUPTCY', crisisId: crisis.id }, { silent: true }));
          setBankruptcy((now) => (now && error !== null ? { busy: false, error } : null));
        }}
      />
    </View>
  );
}

interface CrisisNoticeProps {
  view: GameView;
  /** Another sheet or screen has the player's attention: hold the notice back until it is gone. */
  suspended: boolean;
}

/**
 * The announcement of a crisis, to everyone except the player who has to pay it (they get the
 * settlement view instead): which property, whose, the bill, whether insurance covered it and
 * whether it is still pending. Dismissing it changes nothing — an unpaid bill stays on the turn bar
 * and the table's card, and the server refuses every move, until it is settled.
 * A phone that opens the game later starts from the latest crisis, so old ones are never replayed.
 */
export function CrisisNotice({ view, suspended }: CrisisNoticeProps) {
  const { state } = view.snapshot;
  const eco = economyOf(state);
  const struck = (eco?.insurance?.crises ?? []).filter((c) => c.propertyKey !== null);
  const latest = struck[struck.length - 1] ?? null;
  const [announced, setAnnounced] = useState<string | null>(latest?.id ?? null);
  if (suspended || !eco || !latest || !latest.propertyKey || latest.id === announced) return null;
  // The player who owes sees the bill itself, not a notice about it.
  if (latest.ownerId === view.me?.id && latest.status !== 'COVERED') return null;

  const deed = getDeed(latest.propertyKey);
  const owner = latest.ownerId === view.me?.id ? 'You' : view.playerName(latest.ownerId);
  const covered = latest.status === 'COVERED';
  const pending = latest.status === 'PENDING';
  const close = () => setAnnounced(latest.id);
  return (
    <Sheet visible title={`Crisis at ${deed.name}`} onClose={close} testID="crisis-notice">
      <Card className={covered ? 'bg-green-50' : 'bg-amber-50'}>
        <Label>
          Checkpoint {latest.checkpoint} · {averageSpaces(eco, latest.checkpointClock)} spaces of average movement
        </Label>
        <Text className="mt-1 text-xl font-black text-ink" testID="crisis-notice-property">
          {deed.name} · {owner === 'You' ? 'yours' : `owned by ${owner}`}
        </Text>
        <Text className="mt-1 text-base font-bold text-ink" testID="crisis-notice-bill">
          Crisis bill: {formatINR(latest.amount)}
        </Text>
        <Text className="mt-2 text-sm font-semibold text-stone-700" testID="crisis-notice-outcome">
          {covered
            ? `Insured: the bill is waived and the policy is used up. ${owner === 'You' ? 'You pay' : `${owner} pays`} nothing.`
            : `Not insured: ${owner === 'You' ? 'you owe' : `${owner} owes`} the bank ${formatINR(latest.amount)}.`}
        </Text>
        <Text className={`mt-2 text-sm font-extrabold ${pending ? 'text-brick' : 'text-green-700'}`} testID="crisis-notice-status">
          {pending ? `Pending — the game waits until ${owner === 'You' ? 'you settle' : `${owner} settles`} it.` : covered ? 'Settled by insurance.' : 'Settled.'}
        </Text>
      </Card>
      <Button title="Got it" size="md" testID="crisis-notice-dismiss" onPress={close} />
    </Sheet>
  );
}
