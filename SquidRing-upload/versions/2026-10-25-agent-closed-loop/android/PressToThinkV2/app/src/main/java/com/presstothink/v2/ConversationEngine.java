package com.presstothink.v2;

import android.content.Context;
import android.os.Handler;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.*;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.*;

/** Main-thread state machine with cancellable network work independent of the Activity. */
public final class ConversationEngine {
    public interface Listener {
        void onChanged(); void onStatus(String status, String detail);
        void onAnswerReady(String spoken, String messageId); void onFailure(String message);
    }
    private final Context context; private final Handler main; private final Listener listener;
    private final BackendClient client; private final AtomicFile storage;
    private final ExecutorService workers = Executors.newCachedThreadPool();
    private JSONArray threads = new JSONArray(); private String currentId = "";
    private boolean deep, pending = true, closed; private volatile int generation;
    public ConversationEngine(Context context, Handler main, Listener listener) {
        this.context = context.getApplicationContext(); this.main = main; this.listener = listener;
        client = new BackendClient(context); storage = new AtomicFile(new File(context.getFilesDir(), "conversations.json"));
        try (InputStream input = storage.openRead()) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            JSONObject saved = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            threads = saved.optJSONArray("threads"); if (threads == null) threads = new JSONArray();
            currentId = saved.optString("currentThreadId"); deep = saved.optBoolean("deepMode"); pending = saved.optBoolean("pendingNewTopic", currentId.isEmpty());
        } catch (FileNotFoundException ignored) {} catch (Exception error) { main.post(() -> listener.onFailure("历史记录读取失败，已保留原文件：" + error.getMessage())); }
    }
    private static JSONObject object(Object... values) {
        JSONObject result = new JSONObject(); try { for (int i=0;i<values.length;i+=2) result.put((String)values[i],values[i+1]); } catch (JSONException error) { throw new IllegalStateException(error); } return result;
    }
    private JSONObject thread() { return find(currentId); }
    private JSONObject find(String id) { for(int i=0;i<threads.length();i++) if(id.equals(threads.optJSONObject(i).optString("id"))) return threads.optJSONObject(i); return null; }
    public JSONObject snapshot() {
        return object("threads",threads,"currentThreadId",currentId,"deepMode",deep,"pendingNewTopic",pending);
    }
    private void changed() {
        FileOutputStream output = null;
        try { output=storage.startWrite(); output.write(snapshot().toString().getBytes(StandardCharsets.UTF_8)); storage.finishWrite(output); }
        catch(Exception error) { if(output!=null) storage.failWrite(output); listener.onFailure("会话保存失败："+error.getMessage()); }
        listener.onChanged();
    }
    public BackendClient backend() { return client; }
    public void interrupt() { generation++; client.cancel(); listener.onStatus(latestSpoken().isEmpty()?"idle":"ready", ""); }
    public void newTopic() { interrupt(); pending=true; changed(); }
    public void selectThread(String id) { if(find(id)==null) return; interrupt(); currentId=id; pending=false; changed(); }
    public void setDeepMode(boolean value) { deep=value; changed(); }
    public void close() { closed=true; interrupt(); workers.shutdownNow(); }
    public String latestMessageId() { JSONObject msg=lastAnswer(); return msg==null?"":msg.optString("id"); }
    public String latestSpoken() { JSONObject msg=lastAnswer(); return msg==null?"":(msg.optString("spoken").trim().isEmpty()?msg.optString("summary"):msg.optString("spoken")); }
    private JSONObject lastAnswer() {
        if(pending||thread()==null) return null; JSONArray messages=thread().optJSONArray("messages");
        for(int i=messages.length()-1;i>=0;i--) { JSONObject msg=messages.optJSONObject(i); if("assistant".equals(msg.optString("role")) && !(msg.optString("spoken").trim().isEmpty() && msg.optString("summary").trim().isEmpty())) return msg; } return null;
    }
    public String recordingPath(String id) {
        for(int i=0;i<threads.length();i++) { JSONArray msgs=threads.optJSONObject(i).optJSONArray("messages"); for(int j=0;j<msgs.length();j++) { JSONObject m=msgs.optJSONObject(j); if(id.equals(m.optString("id"))) return m.optString("audioPath"); } } return "";
    }
    private void apply(int job, Runnable action) { main.post(() -> { if(!closed&&generation==job) action.run(); }); }
    public void submitText(String text) {
        if(text==null||text.trim().isEmpty()) return;
        if(text.length()>20_000) { listener.onFailure("文字过长，请分段发送"); return; }
        start(text.trim(),null);
    }
    public void submitAudio(byte[] pcm) {
        if(pcm==null||pcm.length<6400||pcm.length>RingAudioDecoder.MAX_PCM_BYTES) { listener.onFailure("戒指录音长度不合适，请重新按住说话"); return; }
        start(null, pcm.clone());
    }
    private void start(String text, byte[] pcm) {
        interrupt(); final int job=generation; final boolean isAudio=pcm!=null;
        String contextText=""; JSONObject t=thread();
        if(!pending&&t!=null) contextText=t.optJSONArray("messages").toString();
        final String recent=contextText.length()>4000?contextText.substring(contextText.length()-4000):contextText;
        listener.onStatus("thinking",isAudio?"正在识别戒指语音":"正在理解指令");
        workers.execute(() -> {
            try {
                String original=text, corrected=text, audioPath="";
                if(isAudio) {
                    audioPath=saveWav(pcm);
                    original=client.request("/api/tencent-transcript",object("audio",Base64.encodeToString(pcm,Base64.NO_WRAP))).optString("transcript").trim();
                    if(original.isEmpty()) throw new IOException("没有识别到有效语音，原音已保留");
                    if(generation!=job) return;
                    try { corrected=client.request("/api/transcript",object("transcript",original,"context",recent)).optString("correctedText",original); }
                    catch(Exception error) { if(generation!=job) return; corrected=original; }
                }
                if(generation!=job) return;
                JSONObject route;
                try { route=client.request("/api/interpret-command",object("text",corrected)); }
                catch(Exception error) { if(generation!=job) return; throw new IOException("指令处理失败，请重试："+error.getMessage()); }
                final String input=corrected, source=original, path=audioPath;
                apply(job,()->processRoute(job,route,input,source,path));
            } catch(Exception error) { apply(job,()->listener.onFailure(error.getMessage()==null?"请求失败":error.getMessage())); }
        });
    }
    private void processRoute(int job,JSONObject route,String input,String source,String audioPath) {
        String mode=route.optString("mode","keep"); if("deep".equals(mode)) deep=true; if("fast".equals(mode)) deep=false;
        if(route.optBoolean("newTopic")) pending=true;
        String query=route.optString("resumeQuery");
        if(!query.isEmpty()) {
            JSONArray candidates=new JSONArray();
            for(int i=Math.max(0,threads.length()-40);i<threads.length();i++) {
                JSONObject t=threads.optJSONObject(i); JSONArray messages=t.optJSONArray("messages"); StringBuilder recent=new StringBuilder();
                for(int j=Math.max(0,messages.length()-12);j<messages.length();j++) { JSONObject m=messages.optJSONObject(j); recent.append(m.optString("role")).append(": ").append(m.optString("content")).append('\n'); }
                String content=recent.toString(); if(content.length()>5000) content=content.substring(content.length()-5000);
                candidates.put(object("id",t.optString("id"),"title",t.optString("title"),"updatedAt",t.optLong("updatedAt"),"content",content));
            }
            workers.execute(()-> {
                try { String id=client.request("/api/search-threads",object("query",query,"candidates",candidates)).optString("selectedThreadId");
                    apply(job,()-> { if(find(id)==null) { changed(); listener.onFailure("没有找到对应历史会话，请在会话列表中选择"); return; } currentId=id; pending=false; sendPrompt(job,route.optString("prompt",input),source,audioPath); });
                } catch(Exception error) { apply(job,()->listener.onFailure("恢复历史失败："+error.getMessage())); }
            }); return;
        }
        sendPrompt(job,route.optString("prompt",input),source,audioPath);
    }
    private void sendPrompt(int job,String prompt,String original,String audioPath) {
        if(prompt.trim().isEmpty()) { changed(); listener.onStatus("idle","指令已完成"); return; }
        if(pending||thread()==null) {
            currentId=UUID.randomUUID().toString(); pending=false;
            threads.put(object("id",currentId,"title",prompt.substring(0,Math.min(22,prompt.length())),"createdAt",System.currentTimeMillis(),"updatedAt",System.currentTimeMillis(),"messages",new JSONArray()));
        }
        JSONObject target=thread(); String targetId=currentId;
        JSONArray msgs=target.optJSONArray("messages");
        msgs.put(object("id",UUID.randomUUID().toString(),"role","user","content",prompt,"createdAt",System.currentTimeMillis(),"originalTranscript",original,"audioPath",audioPath));
        try { target.put("updatedAt",System.currentTimeMillis()); } catch(JSONException ignored) {}
        JSONArray history=new JSONArray(); for(int i=Math.max(0,msgs.length()-30);i<msgs.length();i++) { JSONObject m=msgs.optJSONObject(i); history.put(object("role",m.optString("role"),"content",m.optString("content"))); }
        changed(); listener.onStatus("thinking","正在生成回答"); boolean deepRequest=deep;
        workers.execute(()-> {
            try {
                String answer=client.request("/api/chat",object("mode",deepRequest?"deep":"normal","messages",history)).optString("fullAnswer");
                if(answer.trim().isEmpty()) throw new IOException("模型返回了空回答");
                String messageId=UUID.randomUUID().toString();
                apply(job,()-> {
                    JSONObject conversation=find(targetId); if(conversation==null) return;
                    conversation.optJSONArray("messages").put(object("id",messageId,"role","assistant","content",answer,"createdAt",System.currentTimeMillis())); changed(); listener.onStatus("thinking","完整回答已保存，正在整理摘要");
                    workers.execute(()-> {
                        JSONObject summary;
                        try { summary=client.request("/api/summarize",object("question",prompt,"fullAnswer",answer)); }
                        catch(Exception error) { summary=object("summary",fallback(answer),"spokenAnswer",fallback(answer)); }
                        final JSONObject result=summary;
                        apply(job,()-> {
                            JSONArray list=conversation.optJSONArray("messages");
                            for(int i=0;i<list.length();i++) { JSONObject m=list.optJSONObject(i); if(messageId.equals(m.optString("id"))) {
                                try { for(String key:new String[]{"summary","suggestion","hypothesis","followUp"}) m.put(key,result.optString(key)); m.put("spoken",result.optString("spokenAnswer",result.optString("summary",fallback(answer)))); } catch(JSONException ignored) {}
                                changed(); listener.onStatus("ready","双击戒指播放摘要"); listener.onAnswerReady(m.optString("spoken"),messageId); break;
                            } }
                        });
                    });
                });
            } catch(Exception error) { apply(job,()->listener.onFailure("回答未完成："+error.getMessage())); }
        });
    }
    private static String fallback(String answer) { String clean=answer.replaceAll("[#*`]","").trim(); return clean.substring(0,Math.min(clean.length(),180)); }
    private String saveWav(byte[] pcm) throws IOException {
        File dir=new File(context.getFilesDir(),"recordings"); if(!dir.isDirectory()&&!dir.mkdirs()) throw new IOException("无法创建录音目录");
        File file=new File(dir,UUID.randomUUID()+".wav");
        ByteBuffer header=ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36+pcm.length).put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000).putShort((short)2).putShort((short)16).put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length);
        try(FileOutputStream output=new FileOutputStream(file)) { output.write(header.array()); output.write(pcm); }
        return file.getAbsolutePath();
    }
}
