import { OnboardingFlow } from '@/features/onboarding/OnboardingFlow';
import { useOnboardingStore } from '@/store/onboardingStore';
import { goBack } from '@/utils/navigation';

/**
 * The introduction, opened on purpose (House rules → "Replay intro"). The first launch shows the
 * same flow from Home, without this route. Watching it again changes nothing: it only ever marks
 * the introduction as seen, and closes back to where it was opened from.
 */
export default function Onboarding() {
  const complete = useOnboardingStore((s) => s.complete);
  return (
    <OnboardingFlow
      onFinish={() => {
        complete();
        goBack('/');
      }}
    />
  );
}
