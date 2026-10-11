import { PermissionsAndroid, Platform } from 'react-native';
import { Camera } from 'expo-camera';
import type { MicPermission } from './voiceController';

/**
 * The microphone permission, asked for when voice is first used (never at launch). Returns
 * 'blocked' when the system will not show the prompt again: only system settings can change it.
 * expo-camera owns the permission in this app (its config plugin writes the iOS usage text and
 * the Android RECORD_AUDIO permission), so no extra native module is needed for it.
 */
export async function requestMicPermission(): Promise<Exclude<MicPermission, 'unknown'>> {
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

/**
 * Android 12+: routing voice to a Bluetooth headset needs BLUETOOTH_CONNECT. Asked after the
 * microphone; a "no" only means voice stays on the phone's speaker or a wired headset.
 */
async function requestBluetoothRoute(): Promise<void> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 31) return;
  try {
    await PermissionsAndroid.request('android.permission.BLUETOOTH_CONNECT');
  } catch {
    // optional
  }
}
