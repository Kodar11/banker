import { memo } from 'react';
import { Text, View } from 'react-native';
import type { TransactionRecord, TransactionType } from '@/engine/index.ts';
import { formatINR } from '@/utils/currency';

export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  STARTING_FUNDS: 'Starting cash',
  PROPERTY_PURCHASE: 'Bought property',
  RENT_PAYMENT: 'Rent',
  PLAYER_TRANSFER: 'Payment',
  TAX_PAYMENT: 'Income tax',
  HOUSE_PURCHASE: 'Built house',
  HOUSE_SALE: 'Sold house',
  HOTEL_PURCHASE: 'Built hotel',
  HOTEL_SALE: 'Sold hotel',
  PROPERTY_SALE: 'Sold property',
  AUCTION_PAYMENT: 'Won auction',
  LOAN_DISBURSEMENT: 'Loan',
  LOAN_REPAYMENT: 'Loan repayment',
  START_REWARD: 'Passed Start',
  CARD_PAYMENT: 'Card',
  CARD_REWARD: 'Card',
  MORTGAGE: 'Mortgage',
  UNMORTGAGE: 'Unmortgage',
  BANKRUPTCY_SETTLEMENT: 'Bankruptcy',
  UNDO_REVERSAL: 'Undo',
};

interface Props {
  transactions: TransactionRecord[];
  playerId: string;
  nameOf: (id: string | null) => string;
}

/** Append-only history from one player's point of view (+ in, − out). */
export const TransactionList = memo(function TransactionList({ transactions, playerId, nameOf }: Props) {
  const mine = transactions.filter((t) => t.fromPlayerId === playerId || t.toPlayerId === playerId);
  if (!mine.length) return <Text className="text-base text-stone-500">No transactions yet.</Text>;
  return (
    <View className="gap-2" testID="transaction-list">
      {mine.map((t) => {
        const incoming = t.toPlayerId === playerId;
        const other = incoming ? t.fromPlayerId : t.toPlayerId;
        return (
          <View key={t.id} className="flex-row items-center justify-between rounded-xl bg-white px-4 py-3">
            <View className="flex-1 pr-3">
              <Text className="text-base font-bold text-ink">{TRANSACTION_LABELS[t.type]}</Text>
              <Text className="text-xs text-stone-500" numberOfLines={1}>
                {incoming ? 'from' : 'to'} {nameOf(other)} · {t.memo}
              </Text>
            </View>
            <Text className={`text-lg font-extrabold ${incoming ? 'text-green-700' : 'text-brick'}`}>
              {incoming ? '+' : '−'}
              {formatINR(t.amount)}
            </Text>
          </View>
        );
      })}
    </View>
  );
});
