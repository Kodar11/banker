import { goBack } from '@/utils/navigation';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { buildingCount, netWorth, outstandingDebt, ownedBy } from '@/engine/index.ts';
import { Button, Card, Label, Pill, Screen } from '@/components/ui';
import type { GameView } from '@/features/game/useGameView';
import { useGameAction } from '@/features/game/useGameAction';
import { LoanSheet } from '@/features/loan/LoanSheet';
import { TransactionList } from '@/features/transactions/TransactionList';
import { formatINR } from '@/utils/currency';
import { PropertyRow } from './PropertyRow';

export function PlayerView({ view, playerId }: { view: GameView; playerId: string }) {
  const send = useGameAction();
  const [loanOpen, setLoanOpen] = useState(false);
  const { state, transactions } = view.snapshot;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    return (
      <Screen>
        <Text className="mt-10 text-center text-xl font-bold text-cream">Player not found.</Text>
        <Button title="Back" onPress={() => goBack(`/game/${view.snapshot.state.id}`)} />
      </Screen>
    );
  }
  const isMe = view.me?.id === player.id;
  const keys = ownedBy(state, player.id);
  const { houses, hotels } = buildingCount(state, player.id);
  const loans = state.loans.filter((l) => l.playerId === player.id);
  const debt = outstandingDebt(state.loans, player.id);

  return (
    <Screen scroll testID="player-screen">
      <View className="flex-row items-center justify-between">
        <Button size="sm" variant="ghost" title="‹ Back" onPress={() => goBack(`/game/${view.snapshot.state.id}`)} />
        {player.status === 'BANKRUPT' ? <Pill tone="bad">Bankrupt</Pill> : null}
      </View>
      <Card>
        <Label>{isMe ? 'Your wallet' : `${player.name}'s wallet`}</Label>
        <Text className="text-hero text-ink" testID="wallet-balance">
          {formatINR(player.balance)}
        </Text>
        <View className="mt-3 flex-row flex-wrap gap-x-6 gap-y-2">
          <Stat label="Net worth" value={formatINR(netWorth(state, player.id))} />
          <Stat label="Loans owed" value={formatINR(debt)} warn={debt > 0} />
          <Stat label="Houses" value={String(houses)} />
          <Stat label="Hotels" value={String(hotels)} />
        </View>
      </Card>

      <Card>
        <Label>Properties ({keys.length})</Label>
        <View className="mt-3 gap-2">
          {keys.length ? (
            keys.map((k) => <PropertyRow key={k} prop={state.properties[k]} />)
          ) : (
            <Text className="text-base text-stone-500">No properties yet.</Text>
          )}
        </View>
      </Card>

      <Card>
        <View className="flex-row items-center justify-between">
          <Label>Loans</Label>
          {isMe && state.status === 'ACTIVE' && player.status === 'ACTIVE' ? (
            <Button size="sm" variant="secondary" title="Borrow / repay" testID="wallet-loan" onPress={() => setLoanOpen(true)} />
          ) : null}
        </View>
        <View className="mt-3 gap-2">
          {loans.length ? (
            loans.map((l) => (
              <View key={l.id} className="flex-row items-center justify-between rounded-xl bg-white px-4 py-3">
                <View>
                  <Text className="text-base font-bold text-ink">Borrowed {formatINR(l.principal)}</Text>
                  <Text className="text-xs text-stone-500">
                    {l.interestRatePercent}% · total {formatINR(l.totalOwed)} · left {formatINR(l.outstanding)}
                  </Text>
                </View>
                <Pill tone={l.status === 'ACTIVE' ? 'warn' : l.status === 'REPAID' ? 'good' : 'bad'}>{l.status.toLowerCase()}</Pill>
              </View>
            ))
          ) : (
            <Text className="text-base text-stone-500">No loans.</Text>
          )}
        </View>
      </Card>

      <Card>
        <Label>History</Label>
        <View className="mt-3">
          <TransactionList transactions={transactions} playerId={player.id} nameOf={view.playerName} />
        </View>
      </Card>
      {isMe ? <LoanSheet visible={loanOpen} onClose={() => setLoanOpen(false)} view={view} send={send} /> : null}
    </Screen>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <View>
      <Text className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</Text>
      <Text className={`text-lg font-extrabold ${warn ? 'text-brick' : 'text-ink'}`}>{value}</Text>
    </View>
  );
}
