package com.presstothink.v2;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Native transport. Provider credentials always remain on the backend. */
public final class BackendClient {
    private final SharedPreferences prefs;
    private final Set<HttpURLConnection> active = ConcurrentHashMap.newKeySet();
    private volatile long generation;
    public BackendClient(Context context) { prefs = context.getSharedPreferences("squidring", Context.MODE_PRIVATE); }
    public static String validateUrl(String value) {
        try {
            URI uri = new URI(value.trim());
            String host = uri.getHost();
            boolean local = "127.0.0.1".equals(host) || "localhost".equals(host) || "10.0.2.2".equals(host);
            if (host == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null
                || !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && local)))
                throw new IllegalArgumentException();
            return uri.toString().replaceAll("/+$", "");
        } catch (Exception error) { throw new IllegalArgumentException("后端地址须为 HTTPS；电脑调试可用 http://127.0.0.1:3210"); }
    }
    public void cancel() { generation++; for (HttpURLConnection connection : active) connection.disconnect(); }
    public JSONObject request(String path, JSONObject body) throws Exception {
        return request(path, body, false);
    }
    public JSONObject request(String path, JSONObject body, boolean allowHealthCheckWithoutToken) throws Exception {
        long requestGeneration = generation;
        if (!path.matches("/api/[a-z-]+")) throw new IOException("接口路径无效");
        String token = readToken(prefs);
        String base = validateUrl(prefs.getString("backendUrl", "http://127.0.0.1:3210"));
        String host = new URI(base).getHost();
        boolean local = "127.0.0.1".equals(host) || "localhost".equals(host) || "10.0.2.2".equals(host);
        if (token.isEmpty() && !local && (!allowHealthCheckWithoutToken || !"/api/health".equals(path))) throw new IOException("远程后端需要应用访问令牌，请在设置中填写；本机电脑调试无需令牌");
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(20_000); connection.setReadTimeout("/api/chat".equals(path) ? 200_000 : "/api/tencent-transcript".equals(path) ? 120_000 : 95_000);
        connection.setRequestProperty("Accept", "application/json");
        // USB reverse can outlive a restarted backend; do not reuse its stale sockets.
        connection.setRequestProperty("Connection", "close");
        connection.setUseCaches(false);
        if (!token.isEmpty()) connection.setRequestProperty("X-App-Token", token);
        active.add(connection);
        try {
            if (requestGeneration != generation) throw new IOException("请求已取消");
            if (body != null) {
                connection.setRequestMethod("POST"); connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            }
            int code;
            try {
                code = connection.getResponseCode();
            } catch (IOException firstError) {
                // A USB reverse tunnel or the local Node process may have just restarted.
                // Recreate the request once; never retry a cancelled request or a remote call.
                if (requestGeneration != generation || !local || "/api/chat".equals(path)) throw firstError;
                active.remove(connection);
                connection.disconnect();
                connection = (HttpURLConnection) new URL(base + path).openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(20_000); connection.setReadTimeout(95_000);
                connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Connection", "close"); connection.setUseCaches(false);
                if (!token.isEmpty()) connection.setRequestProperty("X-App-Token", token);
                active.add(connection);
                if (body != null) {
                    connection.setRequestMethod("POST"); connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    byte[] retryBytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(retryBytes.length);
                    try (OutputStream output = connection.getOutputStream()) { output.write(retryBytes); }
                }
                code = connection.getResponseCode();
            }
            InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            if (code >= 300 && code < 400) throw new IOException("后端发生重定向，请填写最终 HTTPS 地址");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (output.size() + count > 10_000_000) throw new IOException("后端响应过大");
                    if (requestGeneration != generation) throw new IOException("请求已取消");
                    output.write(buffer, 0, count);
                }
            }
            JSONObject result;
            try { result = new JSONObject(output.toString(StandardCharsets.UTF_8.name())); }
            catch (Exception error) { throw new IOException("后端没有返回有效 JSON（HTTP " + code + "）"); }
            if (code >= 400 || result.has("error")) throw new IOException(result.optString("error", "后端 HTTP " + code));
            return result;
        } catch (IOException error) {
            if (requestGeneration != generation) throw new IOException("请求已取消", error);
            String message = error.getMessage() == null ? "" : error.getMessage();
            if (error instanceof ConnectException || error instanceof EOFException
                || message.toLowerCase(java.util.Locale.ROOT).contains("unexpected end of stream")) {
                throw new IOException("后端连接已断开，请确认电脑后端已启动且手机 USB 已连接，或检查设置中的 HTTPS 后端地址", error);
            }
            throw error;
        } finally { active.remove(connection); connection.disconnect(); }
    }
    private static SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (!store.containsAlias("squidring.backend")) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder("squidring.backend", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey("squidring.backend", null);
    }
    public static void saveToken(Context context, String token) throws Exception {
        if (token.trim().isEmpty()) return;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secretKey());
        byte[] encrypted = cipher.doFinal(token.trim().getBytes(StandardCharsets.UTF_8));
        boolean saved = context.getSharedPreferences("squidring", Context.MODE_PRIVATE).edit()
            .putString("tokenIv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("tokenCipher", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit();
        if (!saved) throw new IOException("访问令牌保存失败，请重试");
    }
    public static void clearToken(Context context) { context.getSharedPreferences("squidring", Context.MODE_PRIVATE).edit().remove("tokenIv").remove("tokenCipher").apply(); }
    private static String readToken(SharedPreferences prefs) throws Exception {
        String encrypted = prefs.getString("tokenCipher", ""); if (encrypted.isEmpty()) return "";
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(prefs.getString("tokenIv", ""), Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }
}
