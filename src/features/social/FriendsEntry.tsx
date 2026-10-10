import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from '@/components/ui';
import { useSocialStore } from '@/store/socialStore';
import { badgesOf } from './logic';
import { useServerNow } from './lobby';

/** Home's way into Friends, with the number of things waiting there. */
export function FriendsEntry({ className = '' }: { className?: string }) {
  const data = useSocialStore((s) => s.data);
  const now = useServerNow(15_000);
  const { total, requests, invites } = badgesOf(data, now);
  const waiting = [requests ? `${requests} friend ${requests === 1 ? 'request' : 'requests'}` : '', invites ? `${invites} game ${invites === 1 ? 'invitation' : 'invitations'}` : ''].filter(Boolean).join(', ');
  return (
    <View className={className}>
      <Button title="Friends" size="sm" variant="ghost" testID="open-friends" accessibilityHint={waiting || (total ? `${total} new` : undefined)} onPress={() => router.push('/friends')} />
      {total > 0 ? (
        <View pointerEvents="none" testID="friends-badge" className="absolute -right-1 -top-1 h-6 min-w-[24px] items-center justify-center rounded-full bg-brick px-1.5">
          <Text className="text-xs font-black text-white">{total > 9 ? '9+' : String(total)}</Text>
        </View>
      ) : null}
    </View>
  );
}
