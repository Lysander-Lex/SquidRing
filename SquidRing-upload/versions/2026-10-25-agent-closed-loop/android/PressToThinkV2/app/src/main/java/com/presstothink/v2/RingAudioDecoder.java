package com.presstothink.v2;

import java.io.ByteArrayOutputStream;

/** Pure Java decoder for the PressToThink Ring Audio notification protocol. */
public final class RingAudioDecoder {
    public static final int SAMPLE_RATE_HZ = 16000;
    public static final int MAX_RECORDING_MS = 90_000;
    public static final int MAX_PCM_BYTES = SAMPLE_RATE_HZ * 2 * (MAX_RECORDING_MS / 1000);

    private static final String GAP_ERROR_PREFIX = "蓝牙缺少 ";
    private static final String GAP_ERROR_SUFFIX = " 个音频包，本段未提交";
    private static final String OVERFLOW_ERROR = "固件发送队列溢出，录音不完整";
    private static final String LIMIT_ERROR = "录音超过90秒或音频数据上限，未提交";

    private ByteArrayOutputStream pcm;
    private volatile boolean recording;
    private long startedAtMs;
    private int nextSequence;
    private long missingPackets;
    private int peak;
    private String invalidError;
    private boolean limitExceeded;

    public void start(long nowMs) {
        pcm = new ByteArrayOutputStream(Math.min(MAX_PCM_BYTES, 8192));
        recording = true;
        startedAtMs = nowMs;
        nextSequence = 0;
        missingPackets = 0;
        peak = 0;
        invalidError = "";
        limitExceeded = false;
    }

    public boolean acceptAudio(byte[] packet, long nowMs) {
        if (!recording || packet == null || packet.length < 3) return false;
        if (nowMs - startedAtMs > MAX_RECORDING_MS) {
            limitExceeded = true;
            markError(LIMIT_ERROR);
            return false;
        }

        int sequence = (packet[0] & 0xff) | ((packet[1] & 0xff) << 8);
        int gap = (sequence - nextSequence) & 0xffff;
        if (gap != 0) {
            if (gap > 32768) return false;
            missingPackets += gap;
            markError(GAP_ERROR_PREFIX + missingPackets + GAP_ERROR_SUFFIX);
        }

        int sampleCount = packet.length - 2;
        long decodedBytes = (long) sampleCount * 2L;
        if (decodedBytes > MAX_PCM_BYTES - pcm.size()) {
            limitExceeded = true;
            markError(LIMIT_ERROR);
            return false;
        }

        byte[] decoded = new byte[(int) decodedBytes];
        for (int i = 0; i < sampleCount; i++) {
            int sample = decodeMuLaw(packet[i + 2] & 0xff);
            if (Math.abs(sample) > peak) peak = Math.abs(sample);
            int offset = i * 2;
            decoded[offset] = (byte) sample;
            decoded[offset + 1] = (byte) (sample >> 8);
        }
        pcm.write(decoded, 0, decoded.length);
        nextSequence = (sequence + 1) & 0xffff;
        return true;
    }

    public void markOverflow() {
        if (recording) markError(OVERFLOW_ERROR);
    }

    public void markError(String error) {
        if (!recording || error == null || error.length() == 0) return;
        if (invalidError.length() == 0) invalidError = error;
        else if (!invalidError.contains(error)) invalidError += "；" + error;
    }

    public boolean isRecording() {
        return recording;
    }

    public boolean isInvalid() {
        return invalidError.length() != 0;
    }

    public boolean hasLimitExceeded() {
        return limitExceeded;
    }

    public long getMissingPackets() {
        return missingPackets;
    }

    public int getPeak() {
        return peak;
    }

    public RecordingResult finish(long nowMs) {
        return finish(nowMs, "");
    }

    public RecordingResult finish(long nowMs, String reason) {
        if (!recording) return new RecordingResult(new byte[0], 0, 0, reason == null ? "" : reason);
        recording = false;
        long heldMs = Math.max(0, nowMs - startedAtMs);
        String error = combineErrors(reason, invalidError);
        byte[] output = pcm.toByteArray();
        pcm = null;
        return new RecordingResult(output, heldMs, peak, error);
    }

    public RecordingResult abort(long nowMs, String reason) {
        return finish(nowMs, reason);
    }

    /** Conservative activity gate, not speech recognition: ignore silence and brief switch clicks. */
    public static boolean hasAudioActivity(byte[] pcm) {
        if (pcm == null || pcm.length < 11200 || (pcm.length & 1) != 0) return false;
        int activeFrames = 0;
        // Ignore 60 ms at either edge, where pressing/releasing the switch causes clicks.
        for (int offset = 1920; offset + 640 <= pcm.length - 1920; offset += 640) {
            long sum = 0, squares = 0;
            int peak = 0;
            for (int i = offset; i < offset + 640; i += 2) {
                int sample = (short) ((pcm[i] & 255) | (pcm[i + 1] << 8));
                sum += sample;
                squares += (long) sample * sample;
                peak = Math.max(peak, Math.abs(sample));
            }
            double mean = sum / 320.0;
            double variance = squares / 320.0 - mean * mean;
            if (variance >= 500.0 * 500.0 && peak >= 1200) activeFrames++;
        }
        return activeFrames >= 12;
    }

    public static int decodeMuLaw(int encoded) {
        int v = (~encoded) & 0xff;
        int magnitude = (((v & 15) << 3) + 132) << ((v >> 4) & 7);
        return (v & 128) != 0 ? 132 - magnitude : magnitude - 132;
    }

    private static String combineErrors(String reason, String invalid) {
        String first = reason == null ? "" : reason;
        String second = invalid == null ? "" : invalid;
        if (first.length() == 0) return second;
        if (second.length() == 0 || first.contains(second)) return first;
        return first + "；" + second;
    }

    public static final class RecordingResult {
        public final byte[] pcm;
        public final long heldMs;
        public final int peak;
        public final String error;

        private RecordingResult(byte[] pcm, long heldMs, int peak, String error) {
            this.pcm = pcm;
            this.heldMs = heldMs;
            this.peak = peak;
            this.error = error;
        }

        public boolean isValid() {
            return error.length() == 0;
        }
    }
}
