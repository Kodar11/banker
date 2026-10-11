import { useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';

const STEP = 5;
const THUMB = 22;

const snap = (value: number) => Math.max(0, Math.min(100, Math.round(value / STEP) * STEP));

/**
 * A compact 0–100 slider (drag or tap the track). Written here rather than pulled in as a native
 * dependency: this is the only slider in the app. Screen readers adjust it in steps.
 */
export function VolumeSlider({ value, onChange, label, testID, disabled = false }: { value: number; onChange: (value: number) => void; label: string; testID?: string; disabled?: boolean }) {
  const [width, setWidth] = useState(0);
  const shown = snap(value);
  const moveTo = (e: GestureResponderEvent) => {
    if (width > 0) onChange(snap((e.nativeEvent.locationX / width) * 100));
  };
  return (
    <View
      testID={testID}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      // Inside a scrolling sheet: once the thumb is held, the sheet must not take the drag.
      onResponderTerminationRequest={() => false}
      onResponderGrant={moveTo}
      onResponderMove={moveTo}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: shown, text: `${shown} percent` }}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (disabled) return;
        if (e.nativeEvent.actionName === 'increment') onChange(snap(shown + 2 * STEP));
        if (e.nativeEvent.actionName === 'decrement') onChange(snap(shown - 2 * STEP));
      }}
      style={{ height: 32, justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}
    >
      {/* Children never take the touch, so locationX is always measured on the track itself. */}
      <View pointerEvents="none" className="h-1.5 rounded-full bg-stone-300">
        <View className="h-1.5 rounded-full bg-felt" style={{ width: `${shown}%` }} />
      </View>
      <View
        pointerEvents="none"
        className="absolute rounded-full border-2 border-white bg-felt"
        style={{ width: THUMB, height: THUMB, left: Math.max(0, (width - THUMB) * (shown / 100)), elevation: 2 }}
      />
    </View>
  );
}
