import { PermissionsAndroid, Platform } from 'react-native';
import { Camera } from 'expo-camera';
import type { MicPermission } from './voiceController';

/**
 * The microphone permission, asked for when voice is first used (never at launch). Returns
 * 'blocked' when the system will not show the prompt again: only system settings can change it.
 * expo-camera owns the permission in this app (its config plugin writes the iOS usage text and
 * the Android RECORD_AUDIO permission), so no extra native module is needed for it.
 */
export function requestMicPermission(): Promise<Exclude<MicPermission, 'unknown'>> {
  // One request at a time: whoever asks while the prompts are open gets the same answer, never a second prompt.
  asking ??= ask().finally(() => {
    asking = null;
  });
  return asking;
}

let asking: Promise<Exclude<MicPermission, 'unknown'>> | null = null;

async function ask(): Promise<Exclude<MicPermission, 'unknown'>> {
  try {
    let res = await Camera.getMicrophonePermissionsAsync();
    if (!res.granted && res.canAskAgain) res = await Camera.requestMicrophonePermissionsAsync();
    if (!res.granted) return res.canAskAgain ? 'denied' : 'blocked';
    await requestBluetoothRoute();
    return 'granted';
  } catch {
    return 'denied';
  }
}

/** The Bluetooth permission has been asked for in this run of the app. */
let bluetoothAsked = false;

/**
 * Android 12+: routing voice to a Bluetooth headset needs BLUETOOTH_CONNECT. Asked after the
 * microphone; a "no" only means voice stays on the phone's speaker or a wired headset.
 *
 * Asked at most ONCE per run of the app, and not at all when already granted. Every request for a
 * permission that is not granted takes the activity through pause/resume — even when Android
 * shows no dialog (denied for good, or not in this build's manifest) — and the app reads that as
 * going to the background and coming back, which restarts the join. Asking on every join made
 * that a loop.
 */
async function requestBluetoothRoute(): Promise<void> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return;
  const permission = 'android.permission.BLUETOOTH_CONNECT';
  try {
    if (bluetoothAsked || (await PermissionsAndroid.check(permission))) return;
    bluetoothAsked = true;
    await PermissionsAndroid.request(permission);
  } catch {
    // optional
  }
}
