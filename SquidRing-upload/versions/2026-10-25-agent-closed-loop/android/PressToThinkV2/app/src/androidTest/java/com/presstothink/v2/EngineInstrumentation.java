package com.presstothink.v2;

import android.app.Instrumentation;
import android.content.*;
import android.os.*;
import org.json.*;
import java.io.File;
import java.util.function.BooleanSupplier;

/** Integration runner. Only installed as a separate test APK; uses an isolated files directory. */
public final class EngineInstrumentation extends Instrumentation {
    private ConversationEngine engine;
    private volatile String status="", failure="";
    private Context isolated;
    @Override public void onCreate(Bundle args){super.onCreate(args);start();}
    @Override public void onStart(){
        Bundle result=new Bundle();SharedPreferences prefs=getTargetContext().getSharedPreferences("squidring",0);
        String previous=prefs.getString("backendUrl","http://127.0.0.1:3210");
        try{
            Context base=getTargetContext();File directory=new File(base.getCacheDir(),"engine-test-"+System.nanoTime());
            if(!directory.mkdirs())throw new AssertionError("test directory");
            isolated=new ContextWrapper(base){@Override public Context getApplicationContext(){return this;}@Override public File getFilesDir(){return directory;}};
            prefs.edit().putString("backendUrl","http://127.0.0.1:41118").commit();
            runOnMainSync(this::createEngine);
            submit("first");await(()->"ready".equals(status));
            check(snapshot().getJSONArray("threads").length()==1,"first conversation");
            String first=snapshot().getString("currentThreadId");
            runOnMainSync(()->check(!engine.latestSpoken().isEmpty(),"spoken answer"));
            submit("new-only");await(()->"idle".equals(status));
            check(snapshot().getJSONArray("threads").length()==1&&snapshot().getBoolean("pendingNewTopic"),"control creates no empty conversation");
            submit("deep-question");await(()->"ready".equals(status));
            check(snapshot().getBoolean("deepMode")&&snapshot().getJSONArray("threads").length()==2,"deep and new conversation");
            submit("resume-only");await(()->"idle".equals(status));
            check(first.equals(snapshot().getString("currentThreadId")),"semantic history recovery");
            submit("slow");Thread.sleep(120);runOnMainSync(()->engine.interrupt());Thread.sleep(850);waitForIdleSync();
            JSONObject firstThread=snapshot().getJSONArray("threads").getJSONObject(0);
            check(firstThread.getJSONArray("messages").length()==3,"cancel discards late answer");
            runOnMainSync(()->check(!engine.latestSpoken().isEmpty(),"older summary remains playable"));
            runOnMainSync(()->{engine.close();createEngine();});
            check(snapshot().getJSONArray("threads").length()==2&&first.equals(snapshot().getString("currentThreadId")),"atomic persistence and restore");
            status="";byte[] pcm=new byte[16000];for(int i=0;i<pcm.length;i++)pcm[i]=(byte)(i%127);
            runOnMainSync(()->engine.submitAudio(pcm));await(()->"ready".equals(status));
            JSONObject last=snapshot().getJSONArray("threads").getJSONObject(0).getJSONArray("messages").getJSONObject(3);
            check(new File(last.getString("audioPath")).isFile(),"ring PCM saved as WAV");
            check(last.getString("originalTranscript").equals("这是戒指录音测试"),"ASR and correction contract");
            check(failure.isEmpty(),"unexpected failure: "+failure);
            result.putString("stream","OK: native conversation, controls, deep mode, history, cancellation, persistence, PCM/ASR/WAV\n");finish(-1,result);
        }catch(Throwable error){result.putString("stream","FAILED: "+error+"\n");finish(0,result);}
        finally{runOnMainSync(()->{if(engine!=null)engine.close();});prefs.edit().putString("backendUrl",previous).commit();}
    }
    private void createEngine(){engine=new ConversationEngine(isolated,new Handler(Looper.getMainLooper()),new ConversationEngine.Listener(){public void onChanged(){}public void onStatus(String value,String detail){status=value;}public void onAnswerReady(String text,String id){}public void onFailure(String message){failure=message;status="error";}});}
    private void submit(String value){status="";runOnMainSync(()->engine.submitText(value));}
    private JSONObject snapshot() throws Exception{JSONObject[] value=new JSONObject[1];runOnMainSync(()->{try{value[0]=new JSONObject(engine.snapshot().toString());}catch(Exception e){throw new IllegalStateException(e);}});return value[0];}
    private void await(BooleanSupplier condition)throws Exception{long end=SystemClock.elapsedRealtime()+6000;while(!condition.getAsBoolean()){if(!failure.isEmpty())throw new AssertionError(failure);if(SystemClock.elapsedRealtime()>end)throw new AssertionError("timeout: "+status);Thread.sleep(30);}}
    private static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
}
