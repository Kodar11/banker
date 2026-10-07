import { useRef } from 'react';
import { Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Button, Sheet } from '@/components/ui';
import { parseJoinCode } from '@/constants/app';

/** Scans the lobby QR code and returns the 6-digit game code. */
export function QrScanner({ visible, onClose, onCode }: { visible: boolean; onClose: () => void; onCode: (code: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  return (
    <Sheet visible={visible} onClose={onClose} title="Scan game QR">
      {!permission?.granted ? (
        <View className="gap-3">
          <Text className="text-base text-stone-600">Allow the camera to scan the host’s QR code.</Text>
          <Button title="Allow camera" onPress={() => void requestPermission()} />
        </View>
      ) : visible ? (
        <View className="h-80 overflow-hidden rounded-3xl">
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              const code = parseJoinCode(data);
              if (!code || handled.current) return;
              handled.current = true;
              onCode(code);
              setTimeout(() => (handled.current = false), 1500);
            }}
          />
        </View>
      ) : null}
    </Sheet>
  );
}
