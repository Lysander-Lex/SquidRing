package com.presstothink.v2;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** Android BLE client for the PressToThink Ring Audio protocol. */
public final class RingBleClient implements AutoCloseable {
    public static final UUID SERVICE_UUID = UUID.fromString("8f5d0001-4bc7-4b8e-8c13-5e4b5b4f2a01");
    public static final UUID CONTROL_UUID = UUID.fromString("8f5d0002-4bc7-4b8e-8c13-5e4b5b4f2a01");
    public static final UUID AUDIO_UUID = UUID.fromString("8f5d0003-4bc7-4b8e-8c13-5e4b5b4f2a01");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final String PREFS = "press_to_think_ring_ble";
    private static final String ADDRESS_KEY = "device_address";
    private static final long SCAN_MS = 5_000L;
    private static final long RECONNECT_MS = 1_500L;
    private static final long MTU_FALLBACK_MS = 1_200L;
    private static final long GATT_OPERATION_TIMEOUT_MS = 5_000L;
    private static final long END_GRACE_MS = 200L;

    private final Context context;
    private final Handler main;
    private final Listener listener;
    private final SharedPreferences prefs;
    private final BluetoothManager bluetoothManager;
    private final BluetoothGattCallback gattCallback = new RingGattCallback();
    private volatile Thread notificationThread;
    private final ExecutorService notificationWorker = Executors.newSingleThreadExecutor(action -> {
        Thread thread = new Thread(action, "RingAudioDecoder");
        notificationThread = thread;
        return thread;
    });

    private BluetoothLeScanner scanner;
    private ScanCallback activeScanCallback;
    private BluetoothGatt activeGatt;
    private BluetoothDevice activeDevice;
    private BluetoothGattCharacteristic audioCharacteristic;
    private BluetoothGattCharacteristic controlCharacteristic;
    private BluetoothGattDescriptor pendingDescriptor;
    private Runnable scanTimeout;
    private Runnable reconnectRunnable;
    private Runnable mtuFallback;
    private Runnable gattOperationTimeout;
    private Runnable recordingTimeout;
    private Runnable endGrace;
    private final Map<String, BluetoothDevice> scanMatches = new LinkedHashMap<>();
    private String requestedAddress;
    private boolean servicesStarted;
    private volatile boolean ready;
    private boolean userStopped;
    private boolean closed;
    private boolean recordingEndPending;
    private long releasedAt;
    private Runnable connectTimeout;
    private volatile BluetoothGatt currentGattForNotifications;
    private final RingAudioDecoder decoder = new RingAudioDecoder();

    public RingBleClient(Context context, Handler main, Listener listener) {
        if (context == null) throw new IllegalArgumentException("context不能为空");
        if (main == null) throw new IllegalArgumentException("main不能为空");
        if (listener == null) throw new IllegalArgumentException("listener不能为空");
        this.context = context.getApplicationContext();
        this.main = main;
        this.listener = listener;
        this.prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.bluetoothManager = (BluetoothManager) this.context.getSystemService(Context.BLUETOOTH_SERVICE);
    }

    public interface Listener {
        void onConnection(boolean ready, String detail);
        void onRecordingStart();
        default void onRecordingRelease() {}
        default void onShortPress() {}
        void onRecordingEnd(byte[] pcm, long heldMs, int peak, String error);
        void onError(String message);
    }

    /** Empty address uses the saved address, or performs one filtered discovery when none is saved. */
    public void connect(final String address) {
        dispatch(() -> connectOnMain(address));
    }

    private void dispatch(Runnable action) {
        if (Looper.myLooper() == main.getLooper()) action.run(); else main.post(action);
    }

    public void disconnect() {
        dispatch(() -> {
            userStopped = true;
            cancelReconnect();
            disconnectOnMain("已断开");
        });
    }

    @Override public void close() {
        dispatch(() -> {
            closed = true;
            userStopped = true;
            cancelReconnect();
            disconnectOnMain("已关闭");
            notificationWorker.shutdown();
        });
    }

    public boolean isReady() {
        return ready;
    }

    public boolean isRecording() {
        return decoder.isRecording();
    }

    public String getSavedAddress() {
        return prefs.getString(ADDRESS_KEY, "");
    }

    private void connectOnMain(String address) {
        closed = false;
        userStopped = false;
        String normalized = normalizeAddress(address);
        String target = normalized.isEmpty() ? normalizeAddress(prefs.getString(ADDRESS_KEY, "")) : normalized;
        // Presence callbacks and repeated taps must not restart an in-flight GATT connection.
        if (activeGatt != null && target.equalsIgnoreCase(requestedAddress)) return;
        if (activeScanCallback != null && target.isEmpty()) return;
        cancelReconnect();
        if (normalized.length() != 0) {
            requestedAddress = normalized;
            prefs.edit().putString(ADDRESS_KEY, normalized).apply();
        } else {
            requestedAddress = normalizeAddress(prefs.getString(ADDRESS_KEY, ""));
        }

        if (activeGatt != null || activeScanCallback != null) {
            disconnectOnMain("正在切换戒指连接");
        }
        if (!hasBlePermissions()) {
            permissionError();
            return;
        }
        if (bluetoothManager == null || bluetoothManager.getAdapter() == null) {
            fail("设备不支持蓝牙");
            return;
        }
        final BluetoothAdapter adapter = bluetoothManager.getAdapter();
        try {
            if (!adapter.isEnabled()) {
                notifyConnection(false, "等待蓝牙开启后重新连接");
                if (!requestedAddress.isEmpty()) scheduleReconnect();
                return;
            }
        } catch (SecurityException error) {
            permissionError();
            return;
        }

        if (requestedAddress.length() != 0) connectAddress(requestedAddress);
        else startFilteredScan(adapter);
    }

    private void connectAddress(String address) {
        if (!BluetoothAdapter.checkBluetoothAddress(address)) {
            fail("蓝牙地址无效：" + address);
            return;
        }
        final BluetoothAdapter adapter = bluetoothManager.getAdapter();
        try {
            if (!adapter.isEnabled()) {
                notifyConnection(false, "等待蓝牙开启后重新连接");
                scheduleReconnect();
                return;
            }
            activeDevice = adapter.getRemoteDevice(address);
            servicesStarted = false;
            pendingDescriptor = null;
            notifyConnection(false, "正在连接戒指 " + address);
            activeGatt = activeDevice.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            currentGattForNotifications = activeGatt;
            if (activeGatt == null) failCurrent("无法创建 BLE GATT 连接");
            else {
                BluetoothGatt pending = activeGatt;
                connectTimeout = () -> { if (isCurrent(pending) && !servicesStarted) failCurrent("戒指连接超时，正在重试"); };
                main.postDelayed(connectTimeout, 15_000);
            }
        } catch (SecurityException error) {
            permissionError();
        } catch (RuntimeException error) {
            failCurrent("无法连接戒指：" + messageOf(error));
        }
    }

    private void startFilteredScan(BluetoothAdapter adapter) {
        try {
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) {
                fail("BLE 扫描器不可用");
                return;
            }
            scanMatches.clear();
            final ScanCallback callback = new RingScanCallback();
            activeScanCallback = callback;
            ScanFilter filter = new ScanFilter.Builder()
                    .setServiceUuid(new ParcelUuid(SERVICE_UUID))
                    .build();
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .build();
            scanner.startScan(java.util.Collections.singletonList(filter), settings, callback);
            notifyConnection(false, "正在扫描 Ring Audio 服务");
            scanTimeout = () -> finishScan(false);
            main.postDelayed(scanTimeout, SCAN_MS);
        } catch (SecurityException error) {
            permissionError();
        } catch (RuntimeException error) {
            fail("无法开始 BLE 扫描：" + messageOf(error));
        }
    }

    private void finishScan(boolean multipleFoundAlready) {
        if (activeScanCallback == null) return;
        ScanCallback callback = activeScanCallback;
        activeScanCallback = null;
        if (scanTimeout != null) main.removeCallbacks(scanTimeout);
        scanTimeout = null;
        try {
            if (scanner != null) scanner.stopScan(callback);
        } catch (SecurityException error) {
            permissionError();
            return;
        }
        if (multipleFoundAlready) return;
        if (scanMatches.size() == 0) {
            fail("未找到提供 Ring Audio 服务的戒指");
        } else if (scanMatches.size() > 1) {
            fail("发现多个戒指，请在设置中填写需要连接的蓝牙地址");
        } else {
            BluetoothDevice device = scanMatches.values().iterator().next();
            String address = device.getAddress();
            requestedAddress = normalizeAddress(address);
            prefs.edit().putString(ADDRESS_KEY, requestedAddress).apply();
            connectAddress(requestedAddress);
        }
    }

    private void acceptScanResult(RingScanCallback source, ScanResult result) {
        if (activeScanCallback != source || result == null || result.getDevice() == null) return;
        try {
            BluetoothDevice device = result.getDevice();
            String address = normalizeAddress(device.getAddress());
            if (address.length() == 0) return;
            scanMatches.put(address, device);
            if (scanMatches.size() > 1) {
                finishScan(true);
                fail("发现多个戒指，请在设置中填写需要连接的蓝牙地址");
            }
        } catch (SecurityException error) {
            permissionError();
        }
    }

    private void startServiceDiscovery(BluetoothGatt gatt) {
        if (!isCurrent(gatt) || servicesStarted) return;
        servicesStarted = true;
        cancelMtuFallback();
        gattOperationTimeout = () -> {
            if (isCurrent(gatt) && audioCharacteristic == null) failCurrent("BLE 服务发现超时");
        };
        main.postDelayed(gattOperationTimeout, GATT_OPERATION_TIMEOUT_MS);
        try {
            if (!gatt.discoverServices()) failCurrent("无法开始 BLE 服务发现");
        } catch (SecurityException error) {
            permissionError();
        }
    }

    private void handleServicesDiscovered(BluetoothGatt gatt, int status) {
        if (!isCurrent(gatt)) return;
        cancelGattOperationTimeout();
        if (status != BluetoothGatt.GATT_SUCCESS) {
            failCurrent("BLE 服务发现失败，status=" + status);
            return;
        }
        BluetoothGattService service = gatt.getService(SERVICE_UUID);
        if (service == null) {
            failCurrent("未找到 Ring Audio 服务");
            return;
        }
        audioCharacteristic = service.getCharacteristic(AUDIO_UUID);
        controlCharacteristic = service.getCharacteristic(CONTROL_UUID);
        if (audioCharacteristic == null || controlCharacteristic == null) {
            failCurrent("Ring Audio 特征不完整");
            return;
        }
        writeNotificationCccd(gatt, audioCharacteristic);
    }

    private void writeNotificationCccd(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
        if (!isCurrent(gatt)) return;
        BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CCCD_UUID);
        if (descriptor == null) {
            failCurrent("特征缺少 CCCD：" + characteristic.getUuid());
            return;
        }
        try {
            if (!gatt.setCharacteristicNotification(characteristic, true)) {
                failCurrent("无法启用 BLE 通知：" + characteristic.getUuid());
                return;
            }
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            pendingDescriptor = descriptor;
            gattOperationTimeout = () -> {
                if (isCurrent(gatt) && pendingDescriptor == descriptor) failCurrent("写入 CCCD 超时");
            };
            main.postDelayed(gattOperationTimeout, GATT_OPERATION_TIMEOUT_MS);
            if (!gatt.writeDescriptor(descriptor)) failCurrent("无法写入 CCCD：" + characteristic.getUuid());
        } catch (SecurityException error) {
            permissionError();
        }
    }

    private void handleDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
        if (!isCurrent(gatt) || descriptor != pendingDescriptor) return;
        cancelGattOperationTimeout();
        pendingDescriptor = null;
        if (status != BluetoothGatt.GATT_SUCCESS) {
            failCurrent("写入 CCCD 失败，status=" + status);
            return;
        }
        if (descriptor.getCharacteristic() == audioCharacteristic) {
            writeNotificationCccd(gatt, controlCharacteristic);
        } else if (descriptor.getCharacteristic() == controlCharacteristic) {
            ready = true;
            notifyConnection(true, "戒指音频已连接");
        }
    }

    private void handleConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
        if (!isCurrent(gatt)) return;
        if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothGatt.STATE_CONNECTED) {
            try {
                gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
                boolean requested = gatt.requestMtu(247);
                if (!requested) startServiceDiscovery(gatt);
                else {
                    mtuFallback = () -> startServiceDiscovery(gatt);
                    main.postDelayed(mtuFallback, MTU_FALLBACK_MS);
                }
            } catch (SecurityException error) {
                permissionError();
            }
        } else if (newState == BluetoothGatt.STATE_DISCONNECTED) {
            handleDisconnected(gatt, "BLE 已断开，status=" + status);
        } else if (status != BluetoothGatt.GATT_SUCCESS) {
            failCurrent("BLE 连接失败，status=" + status);
        }
    }

    private void handleMtuChanged(BluetoothGatt gatt, int mtu, int status) {
        if (!isCurrent(gatt)) return;
        if (!servicesStarted) startServiceDiscovery(gatt);
    }

    private void enqueueCharacteristicChanged(BluetoothGatt gatt, UUID characteristicUuid, byte[] value) {
        if (characteristicUuid == null || value == null || notificationWorker.isShutdown()) return;
        final byte[] copy = value.clone();
        try {
        notificationWorker.execute(() -> {
            if (closed || gatt != currentGattForNotifications) return;
            long receivedAt = SystemClock.elapsedRealtime();
            if (AUDIO_UUID.equals(characteristicUuid)) {
                handleAudio(copy, receivedAt);
            } else if (CONTROL_UUID.equals(characteristicUuid)) {
                handleControl(copy, receivedAt);
            }
        });
        } catch (RejectedExecutionException ignored) {}
    }

    private void handleControl(byte[] value, long now) {
        if (value.length == 0) return;
        int command = value[0] & 0xff;
        if (command == 1) {
            // Refresh throughput for each recording, not only the initial connection.
            try {
                if (activeGatt != null) activeGatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH);
            } catch (SecurityException error) {
                permissionError();
                return;
            }
            if (decoder.isRecording()) finishRecording(recordingEndPending ? "" : "收到重复开始事件，上一段不完整", false);
            cancelEndGrace();
            decoder.start(now);
            recordingEndPending = false;
            releasedAt = 0;
            recordingTimeout = () -> notificationWorker.execute(() -> {
                if (decoder.isRecording()) finishRecording("超过90秒，请松开按钮后重新录音", false);
            });
            main.postDelayed(recordingTimeout, RingAudioDecoder.MAX_RECORDING_MS);
            main.post(listener::onRecordingStart);
        } else if (command == 2) {
            if (!decoder.isRecording()) return;
            recordingEndPending = true;
            releasedAt = now;
            main.post(listener::onRecordingRelease);
            cancelEndGrace();
            endGrace = () -> notificationWorker.execute(() -> {
                if (decoder.isRecording() && recordingEndPending) finishRecording("", false);
            });
            main.postDelayed(endGrace, END_GRACE_MS);
        } else if (command == 3) {
            if (decoder.isRecording()) decoder.markOverflow();
            else main.post(() -> notifyError("固件发送队列溢出，录音不完整"));
        } else if (command == 4) {
            if (decoder.isRecording()) decoder.markError("戒指麦克风初始化失败");
            else main.post(() -> notifyError("戒指麦克风初始化失败，请查看固件串口日志"));
        }
    }

    private void handleAudio(byte[] value, long receivedAt) {
        if (!decoder.isRecording()) return;
        decoder.acceptAudio(value, receivedAt);
        if (decoder.hasLimitExceeded()) finishRecording("", false);
    }

    private void finishRecording(String reason, boolean discardPcm) {
        if (Thread.currentThread() != notificationThread) {
            if (!notificationWorker.isShutdown()) notificationWorker.execute(() -> finishRecording(reason, discardPcm));
            return;
        }
        if (!decoder.isRecording()) return;
        cancelRecordingTimers();
        boolean releasedNormally = recordingEndPending && reason.isEmpty() && !discardPcm;
        long finishedAt = recordingEndPending ? releasedAt : SystemClock.elapsedRealtime();
        recordingEndPending = false;
        RingAudioDecoder.RecordingResult result = decoder.finish(finishedAt, reason);
        if (releasedNormally && result.heldMs < 260 && result.pcm.length < 8320) {
            main.post(listener::onShortPress);
            return;
        }
        byte[] pcm = discardPcm ? new byte[0] : result.pcm;
        main.post(() -> listener.onRecordingEnd(pcm, result.heldMs, result.peak, result.error));
    }

    private void handleDisconnected(BluetoothGatt gatt, String detail) {
        if (!isCurrent(gatt)) return;
        notificationWorker.execute(() -> finishRecording("蓝牙断开，录音不完整，未发送识别", true));
        boolean shouldReconnect = !userStopped && !closed && requestedAddress != null && requestedAddress.length() != 0;
        cancelMtuFallback();
        cancelGattOperationTimeout();
        ready = false;
        activeGatt = null;
        currentGattForNotifications = null;
        servicesStarted = false;
        audioCharacteristic = null;
        controlCharacteristic = null;
        pendingDescriptor = null;
        try { gatt.close(); } catch (SecurityException ignored) {} catch (RuntimeException ignored) {}
        notifyConnection(false, detail);
        if (shouldReconnect) scheduleReconnect();
    }

    private void failCurrent(String detail) {
        if (activeGatt == null) {
            fail(detail);
            if (!userStopped && !closed && requestedAddress != null && !requestedAddress.isEmpty()) scheduleReconnect();
            return;
        }
        BluetoothGatt gatt = activeGatt;
        boolean shouldReconnect = !userStopped && !closed && requestedAddress != null && requestedAddress.length() != 0;
        activeGatt = null;
        currentGattForNotifications = null;
        ready = false;
        cancelMtuFallback();
        cancelGattOperationTimeout();
        try { gatt.disconnect(); } catch (SecurityException ignored) {}
        try { gatt.close(); } catch (SecurityException ignored) {} catch (RuntimeException ignored) {}
        notificationWorker.execute(() -> finishRecording(detail, true));
        audioCharacteristic = null;
        controlCharacteristic = null;
        pendingDescriptor = null;
        finishRecording(detail, true);
        notifyConnection(false, detail);
        notifyError(detail);
        if (shouldReconnect) scheduleReconnect();
    }

    private void disconnectOnMain(String detail) {
        stopScan();
        cancelMtuFallback();
        cancelGattOperationTimeout();
        notificationWorker.execute(() -> finishRecording("蓝牙断开，录音不完整，未发送识别", true));
        BluetoothGatt gatt = activeGatt;
        boolean hadConnection = ready || gatt != null;
        activeGatt = null;
        currentGattForNotifications = null;
        ready = false;
        audioCharacteristic = null;
        controlCharacteristic = null;
        pendingDescriptor = null;
        if (gatt != null) {
            try { gatt.disconnect(); } catch (SecurityException ignored) {}
            try { gatt.close(); } catch (SecurityException ignored) {} catch (RuntimeException ignored) {}
        }
        if (hadConnection) notifyConnection(false, detail);
    }

    private void scheduleReconnect() {
        if (reconnectRunnable != null || userStopped || closed) return;
        reconnectRunnable = () -> {
            reconnectRunnable = null;
            if (!userStopped && !closed && activeGatt == null && requestedAddress != null && requestedAddress.length() != 0) {
                connectAddress(requestedAddress);
            }
        };
        main.postDelayed(reconnectRunnable, RECONNECT_MS);
    }

    private void cancelReconnect() {
        if (reconnectRunnable != null) main.removeCallbacks(reconnectRunnable);
        reconnectRunnable = null;
    }

    private void stopScan() {
        if (activeScanCallback == null) return;
        ScanCallback callback = activeScanCallback;
        activeScanCallback = null;
        if (scanTimeout != null) main.removeCallbacks(scanTimeout);
        scanTimeout = null;
        try {
            if (scanner != null) scanner.stopScan(callback);
        } catch (SecurityException error) {
            permissionError();
        }
    }

    private void cancelMtuFallback() {
        if (connectTimeout != null) main.removeCallbacks(connectTimeout);
        connectTimeout = null;
        if (mtuFallback != null) main.removeCallbacks(mtuFallback);
        mtuFallback = null;
    }

    private void cancelGattOperationTimeout() {
        if (gattOperationTimeout != null) main.removeCallbacks(gattOperationTimeout);
        gattOperationTimeout = null;
    }

    private void cancelEndGrace() {
        if (endGrace != null) main.removeCallbacks(endGrace);
        endGrace = null;
    }

    private void cancelRecordingTimers() {
        if (recordingTimeout != null) main.removeCallbacks(recordingTimeout);
        recordingTimeout = null;
        cancelEndGrace();
    }

    private boolean isCurrent(BluetoothGatt gatt) {
        return !closed && gatt != null && gatt == activeGatt;
    }

    private boolean hasBlePermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                    && context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void permissionError() {
        userStopped = true;
        cancelReconnect();
        String detail = Build.VERSION.SDK_INT >= 31
                ? "缺少蓝牙权限：需要 BLUETOOTH_SCAN 和 BLUETOOTH_CONNECT"
                : "缺少蓝牙权限：需要定位权限才能扫描 BLE 设备";
        if (activeGatt != null) failCurrent(detail);
        else fail(detail);
    }

    private void fail(String detail) {
        notifyConnection(false, detail);
        notifyError(detail);
    }

    private void notifyConnection(boolean connected, String detail) {
        if (Looper.myLooper() == main.getLooper()) listener.onConnection(connected, detail);
        else main.post(() -> listener.onConnection(connected, detail));
    }

    private void notifyError(String message) {
        if (Looper.myLooper() == main.getLooper()) listener.onError(message);
        else main.post(() -> listener.onError(message));
    }

    private static String normalizeAddress(String address) {
        if (address == null) return "";
        return address.trim().toUpperCase(java.util.Locale.US);
    }

    private static String messageOf(Throwable error) {
        return error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
    }

    private final class RingScanCallback extends ScanCallback {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            main.post(() -> acceptScanResult(this, result));
        }

        @Override public void onBatchScanResults(List<ScanResult> results) {
            main.post(() -> {
                if (results == null || activeScanCallback != this) return;
                for (ScanResult result : results) acceptScanResult(this, result);
            });
        }

        @Override public void onScanFailed(int errorCode) {
            main.post(() -> {
                if (activeScanCallback != this) return;
                stopScan();
                fail("BLE 扫描失败，error=" + errorCode);
            });
        }
    }

    private final class RingGattCallback extends BluetoothGattCallback {
        @Override public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            main.post(() -> handleConnectionStateChange(gatt, status, newState));
        }

        @Override public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            main.post(() -> handleMtuChanged(gatt, mtu, status));
        }

        @Override public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            main.post(() -> handleServicesDiscovered(gatt, status));
        }

        @Override public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
            main.post(() -> handleDescriptorWrite(gatt, descriptor, status));
        }

        @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            byte[] value = characteristic == null ? null : characteristic.getValue();
            UUID uuid = characteristic == null ? null : characteristic.getUuid();
            enqueueCharacteristicChanged(gatt, uuid, value);
        }

        @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) {
            UUID uuid = characteristic == null ? null : characteristic.getUuid();
            enqueueCharacteristicChanged(gatt, uuid, value);
        }
    }
}
