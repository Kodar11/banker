import { router, type Href } from 'expo-router';

/** Go back only when there is history; otherwise navigate explicitly (e.g. after a reload/deep link). */
export function goBack(fallback: Href = '/'): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
