package com.presstothink.v2;

/** Plain-Java protocol tests. Run with: java -ea com.presstothink.v2.RingAudioDecoderTest */
public final class RingAudioDecoderTest {
    public static void main(String[] args) {
        testAudioActivity();
        testMuLawVectors();
        testNormalStartAndEnd();
        testSequenceWrapAndDuplicate();
        testMissingPacket();
        testOverflow();
        testLimits();
        System.out.println("RingAudioDecoderTest: OK");
    }

    private static void testAudioActivity() {
        byte[] pcm = new byte[32000];
        assertFalse(RingAudioDecoder.hasAudioActivity(pcm), "silence rejected");
        for (int i = 0; i < pcm.length; i += 2) {
            short sample = (short) (100 * Math.sin(i * 0.1));
            pcm[i] = (byte) sample; pcm[i + 1] = (byte) (sample >> 8);
        }
        assertFalse(RingAudioDecoder.hasAudioActivity(pcm), "low background rejected");
        for (int i = 8000; i < 8640; i += 2) { pcm[i] = 0; pcm[i + 1] = 80; }
        assertFalse(RingAudioDecoder.hasAudioActivity(pcm), "brief click rejected");
        for (int i = 0; i < pcm.length; i += 2) {
            short sample = (short) (2000 * Math.sin(i * 0.1));
            pcm[i] = (byte) sample; pcm[i + 1] = (byte) (sample >> 8);
        }
        assertTrue(RingAudioDecoder.hasAudioActivity(pcm), "sustained audio accepted");
    }

    private static void testMuLawVectors() {
        assertEquals(0, RingAudioDecoder.decodeMuLaw(0xff), "mu-law silence");
        assertEquals(-32124, RingAudioDecoder.decodeMuLaw(0x00), "mu-law negative full scale");
        assertEquals(32124, RingAudioDecoder.decodeMuLaw(0x80), "mu-law positive full scale");
        assertEquals(0, RingAudioDecoder.decodeMuLaw(0x7f), "mu-law negative zero");
        assertEquals(0, RingAudioDecoder.decodeMuLaw(0xff ^ 0x80), "mu-law positive zero");
    }

    private static void testNormalStartAndEnd() {
        RingAudioDecoder decoder = new RingAudioDecoder();
        decoder.start(1000);
        assertTrue(decoder.acceptAudio(packet(0, 0xff, 0x80), 1001), "first packet accepted");
        RingAudioDecoder.RecordingResult result = decoder.finish(1125);
        assertEquals(4, result.pcm.length, "decoded PCM byte count");
        assertEquals(125L, result.heldMs, "held duration");
        assertEquals(32124, result.peak, "peak");
        assertEquals("", result.error, "normal recording has no error");
        assertTrue(result.isValid(), "normal recording is valid");
    }

    private static void testSequenceWrapAndDuplicate() {
        RingAudioDecoder decoder = new RingAudioDecoder();
        decoder.start(0);
        for (int sequence = 0; sequence <= 0xffff; sequence++) {
            assertTrue(decoder.acceptAudio(packet(sequence, 0xff), sequence + 1), "sequence accepted: " + sequence);
        }
        assertTrue(decoder.acceptAudio(packet(0, 0xff), 0x10001), "sequence wrap accepted");
        assertFalse(decoder.acceptAudio(packet(0, 0xff), 0x10002), "duplicate packet ignored");
        assertEquals(131074L, decoder.finish(0x10003).pcm.length, "duplicate did not add PCM");

        decoder.start(10);
        assertTrue(decoder.acceptAudio(packet(0, 0xff), 11), "reset sequence accepted");
        assertFalse(decoder.acceptAudio(packet(0xffff, 0xff), 12), "stale packet ignored");
        assertEquals(0L, decoder.getMissingPackets(), "stale packet is not a gap");
        decoder.finish(13);
    }

    private static void testMissingPacket() {
        RingAudioDecoder decoder = new RingAudioDecoder();
        decoder.start(0);
        decoder.acceptAudio(packet(0, 0xff), 1);
        assertTrue(decoder.acceptAudio(packet(2, 0xff), 2), "later packet accepted after gap");
        assertEquals(1L, decoder.getMissingPackets(), "one packet missing");
        RingAudioDecoder.RecordingResult result = decoder.finish(3);
        assertTrue(result.error.contains("缺少 1 个音频包"), "missing packet reported");
        assertFalse(result.isValid(), "missing packet invalidates recording");
    }

    private static void testOverflow() {
        RingAudioDecoder decoder = new RingAudioDecoder();
        decoder.start(0);
        decoder.acceptAudio(packet(0, 0xff), 1);
        decoder.markOverflow();
        RingAudioDecoder.RecordingResult result = decoder.finish(2);
        assertTrue(result.error.contains("固件发送队列溢出"), "overflow reported");
        assertFalse(result.isValid(), "overflow invalidates recording");
    }

    private static void testLimits() {
        RingAudioDecoder decoder = new RingAudioDecoder();
        decoder.start(0);
        assertFalse(decoder.acceptAudio(packet(0, 0xff), 90_001), "packet after 90 seconds rejected");
        RingAudioDecoder.RecordingResult result = decoder.finish(90_001);
        assertTrue(result.error.contains("90秒"), "duration limit reported");

        decoder.start(0);
        byte[] fullPacket = new byte[242];
        fullPacket[0] = 0;
        fullPacket[1] = 0;
        for (int i = 2; i < fullPacket.length; i++) fullPacket[i] = (byte) 0xff;
        int sequence = 0;
        long now = 1;
        while (decoder.acceptAudio(fullPacket, now)) {
            sequence++;
            fullPacket[0] = (byte) sequence;
            fullPacket[1] = (byte) (sequence >>> 8);
            now++;
        }
        assertTrue(decoder.hasLimitExceeded(), "PCM byte limit reported");
        assertTrue(decoder.finish(now).error.contains("数据上限"), "PCM byte limit invalidates recording");
    }

    private static byte[] packet(int sequence, int... muLawBytes) {
        byte[] packet = new byte[2 + muLawBytes.length];
        packet[0] = (byte) sequence;
        packet[1] = (byte) (sequence >>> 8);
        for (int i = 0; i < muLawBytes.length; i++) packet[i + 2] = (byte) muLawBytes[i];
        return packet;
    }

    private static void assertTrue(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void assertFalse(boolean value, String message) {
        assertTrue(!value, message);
    }

    private static void assertEquals(long expected, long actual, String message) {
        if (expected != actual) throw new AssertionError(message + ": expected=" + expected + ", actual=" + actual);
    }

    private static void assertEquals(String expected, String actual, String message) {
        if (!expected.equals(actual)) throw new AssertionError(message + ": expected=" + expected + ", actual=" + actual);
    }
}
