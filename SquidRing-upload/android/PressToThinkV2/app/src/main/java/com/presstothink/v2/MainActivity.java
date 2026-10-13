package com.presstothink.v2;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.net.URI;

public class MainActivity extends Activity {
    private static final int AUDIO_PERMISSION_REQUEST = 42;
    private final Object captureLock = new Object();
    private WebView webView;
    private EditText addressInput;
    private AudioRecord recorder;
    private Thread captureThread;
    private volatile boolean capturing;
    private volatile boolean cancelled;
    private volatile boolean captureRequested;
    private volatile String pendingUrl = "http://127.0.0.1:3210/";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.rgb(247, 244, 237));

        LinearLayout bar = new LinearLayout(this);
        bar.setPadding(12, 8, 12, 8);
        addressInput = new EditText(this);
        addressInput.setSingleLine(true);
        addressInput.setText("http://127.0.0.1:3210/");
        addressInput.setTextSize(12);
        bar.addView(addressInput, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button connect = new Button(this);
        connect.setText("连接 V2");
        connect.setOnClickListener(view -> openAddress());
        bar.addView(connect);
        layout.addView(bar);

        webView = new WebView(this);
        WebSettings webSettings = webView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !isLocalUrl(url); }
        });
        webView.addJavascriptInterface(new AudioBridge(), "PTTAndroid");
        layout.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(layout);
        openAddress();
    }

    private boolean isLocalUrl(String value) {
        try {
            URI url = URI.create(value);
            return "http".equals(url.getScheme()) && ("127.0.0.1".equals(url.getHost()) || "10.0.2.2".equals(url.getHost())) && url.getPort() == 3210;
        } catch (Exception ignored) { return false; }
    }

    private void openAddress() {
        String url = addressInput.getText().toString().trim();
        if (!url.endsWith("/")) url += "/";
        if (!isLocalUrl(url)) {
            Toast.makeText(this, "只支持 USB 转发的 127.0.0.1:3210，或模拟器 10.0.2.2:3210", Toast.LENGTH_LONG).show();
            return;
        }
        pendingUrl = url;
        webView.loadUrl(url);
    }

    public final class AudioBridge {
        @JavascriptInterface public void startCapture() { captureRequested = true; runOnUiThread(() -> {
            if (!captureRequested) return;
            if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION_REQUEST);
            } else startRecording();
        }); }
        @JavascriptInterface public void stopCapture() { stopRecording(false); }
        @JavascriptInterface public void cancelCapture() { stopRecording(true); }
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != AUDIO_PERMISSION_REQUEST) return;
        if (!captureRequested) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) startRecording();
        else emitAudio("", "请允许麦克风权限后重试");
    }

    private void startRecording() {
        synchronized (captureLock) {
            if (capturing) return;
            int minBuffer = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minBuffer <= 0) { emitAudio("", "手机麦克风不可用"); return; }
            try {
                recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuffer, 3200));
                if (recorder.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("录音设备初始化失败");
                recorder.startRecording();
            } catch (Exception error) { emitAudio("", "无法启动手机麦克风：" + error.getMessage()); return; }
            cancelled = false;
            capturing = true;
            AudioRecord active = recorder;
            captureThread = new Thread(() -> {
                ByteArrayOutputStream audio = new ByteArrayOutputStream();
                byte[] chunk = new byte[3200];
                long deadline = System.currentTimeMillis() + 60000;
                while (capturing && System.currentTimeMillis() < deadline) {
                    int count = active.read(chunk, 0, chunk.length);
                    if (count > 0) audio.write(chunk, 0, count);
                }
                try { active.stop(); } catch (Exception ignored) {}
                active.release();
                synchronized (captureLock) { if (recorder == active) recorder = null; capturing = false; }
                if (!cancelled) emitAudio(Base64.encodeToString(audio.toByteArray(), Base64.NO_WRAP), "");
            }, "PressToThinkAudio");
            captureThread.start();
        }
    }

    private void stopRecording(boolean discard) {
        captureRequested = false;
        cancelled = discard;
        capturing = false;
        if (recorder == null && !discard) emitAudio("", "录音尚未开始，请授权后重试");
    }

    private void emitAudio(String audio, String error) {
        runOnUiThread(() -> {
            String script = "window.pttAndroidAudioReady && window.pttAndroidAudioReady(" + JSONObject.quote(audio) + "," + JSONObject.quote(error) + ")";
            webView.evaluateJavascript(script, null);
        });
    }

    @Override public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onDestroy() {
        stopRecording(true);
        webView.destroy();
        super.onDestroy();
    }
}
