package com.presstothink.v2;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.*;
import android.media.session.*;
import android.os.*;
import android.speech.tts.*;
import android.util.Base64;
import android.util.Log;
import org.json.*;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;

/** Owns BLE, conversation and playback; never depends on WebView lifecycle. */
public final class RingService extends Service implements RingBleClient.Listener, ConversationEngine.Listener {
    public static final String CONNECT="com.presstothink.CONNECT", STOP="com.presstothink.STOP", PRESENCE="com.presstothink.PRESENCE", PLAY="com.presstothink.PLAY";
    private final Handler main=new Handler(Looper.getMainLooper());
    private final LocalBinder binder=new LocalBinder();
    private final Set<Runnable> observers=new HashSet<>();
    private final ExecutorService audioWorker=Executors.newSingleThreadExecutor();
    private RingBleClient ring; private ConversationEngine engine; private BackendClient voiceClient;
    private String status="idle",detail="请在设置中连接戒指",connection="戒指未连接";
    private boolean connected, foreground, ringEnabled, destroyed, ttsReady; private long lastTap;
    private int playGeneration; private MediaPlayer player; private TextToSpeech tts;
    private AudioManager manager; private AudioFocusRequest focus; private MediaSession mediaSession;
    private PowerManager.WakeLock wake; private Runnable holdAction;
    public final class LocalBinder extends Binder { public RingService service(){return RingService.this;} }
    @Override public IBinder onBind(Intent intent){return binder;}
    @Override public void onCreate(){
        super.onCreate(); manager=(AudioManager)getSystemService(AUDIO_SERVICE);
        PowerManager power=(PowerManager)getSystemService(POWER_SERVICE);
        wake=power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"SquidRing:interaction"); wake.setReferenceCounted(false);
        NotificationChannel channel=new NotificationChannel("ring", "鱿鱼戒指后台连接",NotificationManager.IMPORTANCE_LOW);
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
        engine=new ConversationEngine(this,main,this); ring=new RingBleClient(this,main,this); voiceClient=new BackendClient(this);
        mediaSession=new MediaSession(this,"SquidRing");
        mediaSession.setCallback(new MediaSession.Callback(){
            @Override public void onPlay(){playLatest();}
            @Override public void onPause(){stopSpeaking();}
            @Override public void onStop(){stopSpeaking();}
        },main);
        setPlaybackState(false);
        tts=new TextToSpeech(this,result->main.post(()->{
            if(destroyed)return;
            ttsReady=result==TextToSpeech.SUCCESS;
            if(ttsReady) { int available=tts.setLanguage(Locale.SIMPLIFIED_CHINESE); ttsReady=available!=TextToSpeech.LANG_MISSING_DATA&&available!=TextToSpeech.LANG_NOT_SUPPORTED; }
        }));
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener(){
            public void onStart(String id){}
            public void onDone(String id){main.post(()->{if(!destroyed&&id.equals("squid-"+playGeneration)) stopSpeaking();});}
            public void onError(String id){main.post(()->{if(!destroyed&&id.equals("squid-"+playGeneration)) playbackFailed("系统语音播放失败，请检查中文语音引擎");});}
        });
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&STOP.equals(intent.getAction())) {
            ringEnabled=false; cancelHold(); ring.disconnect(); engine.interrupt(); stopSpeaking();
            getSharedPreferences("squidring",0).edit().putBoolean("enabled",false).apply();
            foreground=false;stopForeground(STOP_FOREGROUND_REMOVE);stopSelf();return START_NOT_STICKY;
        }
        if(intent!=null&&PLAY.equals(intent.getAction())) {
            try {
                promote(true);
                String recording=intent.getStringExtra("recording");
                if(recording==null)playLatestInternal();else playRecordingInternal(recording);
            }catch(Exception error){playbackFailed("无法开始后台播放："+error.getMessage());}
            main.post(this::stopPlaybackOnlyServiceIfIdle);
            return START_NOT_STICKY;
        }
        if(intent==null&&!getSharedPreferences("squidring",0).getBoolean("enabled",false)){stopSelf();return START_NOT_STICKY;}
        if(intent!=null&&PRESENCE.equals(intent.getAction())&&ringEnabled){if(!ring.isReady())ring.connect(getSharedPreferences("press_to_think_ring_ble",0).getString("device_address",""));return START_STICKY;}
        try {
            ringEnabled=true; promote(false);
            getSharedPreferences("squidring",0).edit().putBoolean("enabled",true).apply();
            ring.connect(getSharedPreferences("squidring",0).getString("deviceAddress",""));
        } catch(Exception error){ringEnabled=false;onFailure("后台服务启动失败："+error.getMessage());stopSelf();return START_NOT_STICKY;}
        return START_STICKY;
    }
    private Notification notification(){
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop=PendingIntent.getService(this,1,new Intent(this,RingService.class).setAction(STOP),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        String notificationStatus="listening".equals(status)?"正在接收戒指语音":"thinking".equals(status)?"正在处理请求":"speaking".equals(status)?"正在播放语音":connected?"已连接":"连接服务";
        return new Notification.Builder(this,"ring").setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setContentTitle("鱿鱼戒指 · "+notificationStatus)
            .setContentText(connected?"戒指服务在后台运行":"正在等待戒指连接").setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(new Notification.Action.Builder(null,"断开并停止",stop).build()).build();
    }
    private void promote(boolean playback){
        boolean allowed=Build.VERSION.SDK_INT<31||checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)==PackageManager.PERMISSION_GRANTED;
        if(ringEnabled&&!allowed)throw new SecurityException("请重新允许附近设备权限");
        int types=(ringEnabled?ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE:0)|(playback?ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK:0);
        if(types==0){if(foreground){stopForeground(STOP_FOREGROUND_REMOVE);foreground=false;}return;}
        if(Build.VERSION.SDK_INT>=29)startForeground(11,notification(),types); else startForeground(11,notification());
        foreground=true;
    }
    public void observe(Runnable observer){observers.add(observer);observer.run();}
    public void unobserve(Runnable observer){observers.remove(observer);}
    private void publish(){
        if(destroyed)return;
        if(foreground)((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(11,notification());
        for(Runnable observer:new ArrayList<>(observers))observer.run();
    }
    public JSONObject snapshot(){
        JSONObject result=engine.snapshot();
        try{result.put("status",status).put("detail",detail).put("connected",connected).put("connection",connection)
            .put("backendUrl",getSharedPreferences("squidring",0).getString("backendUrl","http://127.0.0.1:3210"))
            .put("deviceAddress",ring.getSavedAddress()).put("batteryExempt",((PowerManager)getSystemService(POWER_SERVICE)).isIgnoringBatteryOptimizations(getPackageName()));}catch(JSONException ignored){}
        return result;
    }
    private void acquire(){wake.acquire(10*60_000L);}
    private void release(){if(wake.isHeld())wake.release();}
    private boolean busy(){return "listening".equals(status)||"thinking".equals(status)||"speaking".equals(status);}
    private void cancelHold(){if(holdAction!=null)main.removeCallbacks(holdAction);holdAction=null;}
    @Override public void onConnection(boolean ready,String message){if(destroyed)return;connected=ready;connection=message;publish();Log.i("SquidRing",message);}
    @Override public void onError(String message){if(!destroyed){if(busy())notice(message);else onFailure(message);}}
    @Override public void onRecordingStart(){
        cancelHold();acquire();
        holdAction=()->{holdAction=null;lastTap=0;stopSpeaking();engine.interrupt();onStatus("listening","正在接收戒指语音，松开发送");};
        main.postDelayed(holdAction,260);
    }
    @Override public void onRecordingRelease(){cancelHold();}
    @Override public void onRecordingEnd(byte[] pcm,long heldMs,int peak,String error){
        cancelHold();if(destroyed)return;
        if(!error.isEmpty()){onFailure(error);return;}
        lastTap=0;stopSpeaking();
        if(!RingAudioDecoder.hasAudioActivity(pcm)){onStatus("idle","未检测到持续声音，本次未发送；请按住戒指说话");return;}
        engine.submitAudio(pcm);
    }
    @Override public void onShortPress(){
        cancelHold();if(destroyed)return;
        long now=SystemClock.elapsedRealtime();
        if(lastTap>0&&now-lastTap<650){lastTap=0;playLatest();}else {lastTap=now;if(!busy())release();}
    }
    private void notice(String message){detail=message;publish();}
    public void submitText(String text){if(ring.isRecording()){notice("请先松开戒指按钮");return;}stopSpeaking();engine.submitText(text);}
    public boolean isRingEnabled(){return ringEnabled;}
    public void resumeAfterAssociation(){if(ringEnabled)ring.connect(getSharedPreferences("squidring",0).getString("deviceAddress",""));}
    public void disconnectForAssociation(){ring.disconnect();}
    public void newTopic(){stopSpeaking();engine.newTopic();}
    public void selectThread(String id){stopSpeaking();engine.selectThread(id);}
    public void setDeepMode(boolean deep){engine.setDeepMode(deep);}
    public void checkBackend(){
        if(busy())return;
        onStatus("thinking","正在检查服务配置，不会显示密钥");
        audioWorker.execute(()->{
            JSONObject result=null;String error="";
            try{
                result=voiceClient.request("/api/status",null);
            }catch(Exception statusError){
                String message=statusError.getMessage()==null?"":statusError.getMessage();
                if(message.startsWith("远程后端")||message.contains("应用访问令牌无效或缺失"))error=message;
                else try{result=voiceClient.request("/api/health",null,true);}catch(Exception connectionError){error=connectionError.getMessage()==null?"无法访问后端":connectionError.getMessage();}
            }
            JSONObject diagnostics=result;String failure=error;
            main.post(()->{if(destroyed||!"thinking".equals(status)||!"正在检查服务配置，不会显示密钥".equals(detail))return;
                if(diagnostics==null){onFailure("后端不可用："+failure);return;}
                JSONObject model=diagnostics.optJSONObject("model"),asr=diagnostics.optJSONObject("asr"),ttsStatus=diagnostics.optJSONObject("tts");
                boolean modelReady=model!=null&&model.optBoolean("configured")&&model.optBoolean("baseUrlConfigured");
                boolean asrReady=asr!=null&&asr.optBoolean("enabled")&&asr.optBoolean("credentialsConfigured");
                boolean ttsReadyStatus=ttsStatus!=null&&ttsStatus.optBoolean("enabled")&&ttsStatus.optBoolean("credentialsConfigured");
                String modelName=model==null?"":model.optString("name");
                String message="后端可访问；模型 "+(model==null?"状态未知":modelReady?"已配置（"+modelName+"）":"未配置")+"；ASR "+(asr==null?"状态未知":asrReady?"已启用":"未启用或未配置")+"；腾讯 TTS "+(ttsStatus==null?"状态未知":ttsReadyStatus?"已启用":"未启用或未配置")+(diagnostics.optString("version").isEmpty()?"":" · "+diagnostics.optString("version"));
                onStatus("idle",message);
            });
        });
    }
    @Override public void onChanged(){publish();}
    @Override public void onStatus(String value,String message){if(destroyed)return;status=value;detail=message;if(busy())acquire();else release();publish();}
    @Override public void onFailure(String message){if(destroyed)return;status="error";detail=message==null?"操作未完成":message;release();publish();Log.w("SquidRing",detail);}
    @Override public void onAnswerReady(String spoken,String messageId){
        if(destroyed)return;
        Vibrator vibrator=(Vibrator)getSystemService(VIBRATOR_SERVICE);
        if(vibrator.hasVibrator())vibrator.vibrate(VibrationEffect.createWaveform(new long[]{0,100,70,100},-1));
    }
    private boolean focus(){
        focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .setOnAudioFocusChangeListener(change->{if(change<0)main.post(this::stopSpeaking);},main).build();
        return manager.requestAudioFocus(focus)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }
    private void setPlaybackState(boolean playing){
        mediaSession.setActive(playing);
        mediaSession.setPlaybackState(new PlaybackState.Builder().setActions(playing?PlaybackState.ACTION_PAUSE|PlaybackState.ACTION_STOP:PlaybackState.ACTION_PLAY).setState(playing?PlaybackState.STATE_PLAYING:PlaybackState.STATE_PAUSED,0,playing?1:0).build());
    }
    private boolean beginPlayback(String message){
        stopSpeaking();
        try{promote(true);if(!focus())throw new IOException("音频正被通话或其他应用占用");}
        catch(Exception error){playbackFailed("无法开始后台播放："+error.getMessage());return false;}
        onStatus("speaking",message);setPlaybackState(true);return true;
    }
    public void playLatest(){
        if(ring.isRecording()&&!"speaking".equals(status)){notice("请先松开戒指按钮");return;}
        if(engine.latestSpoken().isEmpty()){notice("当前会话还没有可播放的摘要");if(!busy())release();return;}
        startPlaybackService(null);
    }
    private void startPlaybackService(String recording){
        Intent intent=new Intent(this,RingService.class).setAction(PLAY);
        if(recording!=null)intent.putExtra("recording",recording);
        try{startForegroundService(intent);}catch(Exception error){notice("无法启动后台播放："+error.getMessage());}
    }
    private void playLatestInternal(){
        String spoken=engine.latestSpoken(), messageId=engine.latestMessageId();
        if(spoken.isEmpty()){notice("当前会话还没有可播放的摘要");return;}
        engine.interrupt();
        if(!beginPlayback("正在准备语音，长按戒指可打断"))return;
        int job=playGeneration;
        File cache=new File(getCacheDir(),"voice-"+messageId+".mp3");
        if(cache.isFile()&&cache.length()>0){playFile(cache,spoken);return;}
        audioWorker.execute(()->{
            File ready=null;
            try {
                JSONObject result=voiceClient.request("/api/tencent-tts",new JSONObject().put("text",spoken));
                byte[] audio=Base64.decode(result.getString("audio"),Base64.DEFAULT);
                if(audio.length==0||audio.length>5_000_000)throw new IOException("语音数据大小不合适");
                try(FileOutputStream out=new FileOutputStream(cache)){out.write(audio);}ready=cache;
            }catch(Exception ignored){}
            File voice=ready;main.post(()->{if(!destroyed&&job==playGeneration){if(voice!=null)playFile(voice,spoken);else speakSystem(spoken);}});
        });
    }
    private void speakSystem(String text){
        if(!ttsReady){playbackFailed("云端语音不可用，系统中文语音也未就绪，请检查后端语音配置或安装中文语音引擎");return;}
        if(tts.speak(text,TextToSpeech.QUEUE_FLUSH,null,"squid-"+playGeneration)==TextToSpeech.ERROR)playbackFailed("无法启动系统中文语音");
    }
    private void filePlaybackFailed(String fallback){
        if(player!=null){player.release();player=null;}
        if(fallback.isEmpty())playbackFailed("原始录音播放失败");else speakSystem(fallback);
    }
    private void playFile(File file,String fallback){
        int job=playGeneration;
        try{player=new MediaPlayer();player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            player.setWakeMode(this,PowerManager.PARTIAL_WAKE_LOCK);player.setDataSource(file.getAbsolutePath());
            player.setOnPreparedListener(value->{if(!destroyed&&job==playGeneration)value.start();});
            player.setOnCompletionListener(value->{if(!destroyed&&job==playGeneration)stopSpeaking();});
            player.setOnErrorListener((value,what,extra)->{if(!destroyed&&job==playGeneration)filePlaybackFailed(fallback);return true;});player.prepareAsync();
        }catch(Exception error){filePlaybackFailed(fallback);}
    }
    public void playRecording(String id){
        if(ring.isRecording()){notice("请先松开戒指按钮");return;}
        if(engine.recordingPath(id).isEmpty()){notice("没有找到录音");return;}
        startPlaybackService(id);
    }
    private void playRecordingInternal(String id){
        String path=engine.recordingPath(id);if(path.isEmpty()){notice("没有找到录音");return;}
        engine.interrupt();
        if(beginPlayback("正在播放原始输入"))playFile(new File(path),"");
    }
    private void stopPlaybackOnlyServiceIfIdle(){
        if(!destroyed&&!ringEnabled&&!"speaking".equals(status)){promote(false);stopSelf();}
    }
    private void playbackFailed(String message){stopSpeaking();onFailure(message);}
    public void stopSpeaking(){
        playGeneration++;if(voiceClient!=null)voiceClient.cancel();
        if(player!=null){try{player.stop();}catch(Exception ignored){}player.release();player=null;}if(tts!=null)tts.stop();
        if(focus!=null){manager.abandonAudioFocusRequest(focus);focus=null;}
        if(mediaSession!=null)setPlaybackState(false);
        if(!destroyed&&foreground)try{promote(false);}catch(Exception ignored){}
        if("speaking".equals(status))onStatus(engine.latestSpoken().isEmpty()?"idle":"ready","双击戒指播放摘要");
        main.post(this::stopPlaybackOnlyServiceIfIdle);
    }
    @Override public void onDestroy(){
        destroyed=true;cancelHold();ring.close();engine.close();stopSpeaking();tts.shutdown();mediaSession.release();
        audioWorker.shutdownNow();release();observers.clear();super.onDestroy();
    }
}
