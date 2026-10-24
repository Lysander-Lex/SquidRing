package com.presstothink.v2;

import android.Manifest;
import android.app.*;
import android.bluetooth.*;
import android.content.*;
import android.companion.*;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.content.pm.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.webkit.*;
import android.widget.Toast;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public final class MainActivity extends Activity {
    private static final String ORIGIN="https://appassets.androidplatform.net";
    private WebView web; private RingService service; private boolean bound,pageReady;
    private RingService associationService; private boolean associationPending,ringEnabledBeforeAssociation;
    private final Runnable render=this::render;
    private final ServiceConnection connection=new ServiceConnection(){
        public void onServiceConnected(ComponentName name,IBinder binder){service=((RingService.LocalBinder)binder).service();service.observe(render);}
        public void onServiceDisconnected(ComponentName name){service=null;}
    };
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved); getWindow().setStatusBarColor(Color.rgb(247,243,236));getWindow().setNavigationBarColor(Color.rgb(247,243,236));
        web=new WebView(this);web.setBackgroundColor(Color.rgb(247,243,236));setContentView(web);
        if(Build.VERSION.SDK_INT>=27)getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        if(Build.VERSION.SDK_INT>=35)web.setOnApplyWindowInsetsListener((view,insets)->{android.graphics.Insets bars=insets.getInsets(android.view.WindowInsets.Type.systemBars()|android.view.WindowInsets.Type.displayCutout());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;});
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(false);settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if((getApplicationInfo().flags&ApplicationInfo.FLAG_DEBUGGABLE)!=0)WebView.setWebContentsDebuggingEnabled(true);
        web.addJavascriptInterface(new Bridge(),"SquidNative");
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return true;}
            @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){
                Uri uri=request.getUrl();String path=uri.getPath();
                if("https".equals(uri.getScheme())&&"appassets.androidplatform.net".equals(uri.getHost())&&path!=null&&path.matches("/assets/www/[a-z.-]+")){
                    try{String name=path.substring("/assets/".length());String mime=path.endsWith(".html")?"text/html":path.endsWith(".css")?"text/css":"application/javascript";
                        return new WebResourceResponse(mime,"UTF-8",getAssets().open(name));}catch(IOException ignored){}
                }
                return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageFinished(WebView view,String url){pageReady=true;render();}
        });
        web.loadUrl(ORIGIN+"/assets/www/index.html");
        bound=bindService(new Intent(this,RingService.class),connection,BIND_AUTO_CREATE);
    }
    private void render(){if(service!=null&&pageReady)web.evaluateJavascript("window.receiveState && window.receiveState("+service.snapshot()+")",null);}
    private void alert(String message){new AlertDialog.Builder(this).setMessage(message).setPositiveButton("知道了",null).show();}
    private boolean hasPermissions(){
        if(Build.VERSION.SDK_INT>=31)return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)==PackageManager.PERMISSION_GRANTED&&checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)==PackageManager.PERMISSION_GRANTED;
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }
    private void connectRing(){
        ArrayList<String> permissions=new ArrayList<>();
        if(Build.VERSION.SDK_INT>=31){for(String permission:new String[]{Manifest.permission.BLUETOOTH_SCAN,Manifest.permission.BLUETOOTH_CONNECT})if(checkSelfPermission(permission)!=PackageManager.PERMISSION_GRANTED)permissions.add(permission);}
        else if(!hasPermissions())permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        if(!permissions.isEmpty()){requestPermissions(permissions.toArray(new String[0]),42);return;}
        BluetoothManager manager=(BluetoothManager)getSystemService(BLUETOOTH_SERVICE);
        if(manager.getAdapter()==null){alert("手机不支持蓝牙");return;}
        if(!manager.getAdapter().isEnabled()){startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE),43);return;}
        try{startForegroundService(new Intent(this,RingService.class).setAction(RingService.CONNECT));}catch(Exception error){alert("无法启动戒指服务："+error.getMessage());}
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] results){super.onRequestPermissionsResult(code,permissions,results);if(code==42){if(hasPermissions())connectWithoutNotificationPrompt();else alert("需要允许附近设备权限，才能连接戒指");}}
    private void connectWithoutNotificationPrompt(){
        try {
            BluetoothManager manager=(BluetoothManager)getSystemService(BLUETOOTH_SERVICE);
            if(!hasPermissions()){alert("请先允许附近设备权限");return;}
            if(manager.getAdapter()!=null&&manager.getAdapter().isEnabled())startForegroundService(new Intent(this,RingService.class).setAction(RingService.CONNECT));
            else startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE),43);
        } catch(SecurityException error){alert("蓝牙权限已被撤销，请重新授权");}
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==43&&result==RESULT_OK)connectWithoutNotificationPrompt();
        if(request!=44||!associationPending)return;
        if(result!=RESULT_OK){failAssociation(null);return;}
        // API 33 起由 onAssociationCreated 异步完成关联，RESULT_OK 不清理等待状态。
        if(Build.VERSION.SDK_INT>=33)return;
        ScanResult selected=data==null?null:data.getParcelableExtra(CompanionDeviceManager.EXTRA_DEVICE);
        if(selected!=null)completeAssociation(selected.getDevice().getAddress());
        else failAssociation("系统关联未完成：未返回戒指设备");
    }
    private void associateRing(){
        if(associationPending)return;
        if(!hasPermissions()){alert("请先连接戒指并允许附近设备权限，再进行系统关联");return;}
        if(!getPackageManager().hasSystemFeature(PackageManager.FEATURE_COMPANION_DEVICE_SETUP)){alert("此手机不提供系统伴侣设备关联，请使用普通连接并允许后台运行");return;}
        CompanionDeviceManager companion=(CompanionDeviceManager)getSystemService(COMPANION_DEVICE_SERVICE);
        String saved=service.snapshot().optString("deviceAddress");
        if(!saved.isEmpty()&&companion.getAssociations().contains(saved)){completeAssociation(saved);return;}
        ScanFilter filter=new ScanFilter.Builder().setServiceUuid(new ParcelUuid(RingBleClient.SERVICE_UUID)).build();
        AssociationRequest request=new AssociationRequest.Builder().addDeviceFilter(new BluetoothLeDeviceFilter.Builder().setScanFilter(filter).build()).setSingleDevice(false).build();
        CompanionDeviceManager.Callback callback=new CompanionDeviceManager.Callback(){
            @Override public void onDeviceFound(IntentSender chooser){launchAssociation(chooser);}
            @Override public void onAssociationPending(IntentSender chooser){launchAssociation(chooser);}
            @Override public void onAssociationCreated(AssociationInfo info){
                if(!associationPending)return;
                if(Build.VERSION.SDK_INT>=33&&info.getDeviceMacAddress()!=null)completeAssociation(info.getDeviceMacAddress().toString());
                else failAssociation("系统关联未完成：未返回戒指地址");
            }
            @Override public void onFailure(CharSequence error){failAssociation("系统关联未完成："+error);}
        };
        associationService=service;ringEnabledBeforeAssociation=service.isRingEnabled();associationPending=true;
        try{
            // 系统选择器需要戒指广播，临时断开但保留用户的后台启用设置。
            associationService.disconnectForAssociation();
            if(Build.VERSION.SDK_INT>=33)companion.associate(request,getMainExecutor(),callback);else companion.associate(request,callback,new Handler(Looper.getMainLooper()));
        }catch(Exception error){failAssociation("无法发起系统关联："+error.getMessage());}
    }
    private void clearPendingAssociation(){associationPending=false;ringEnabledBeforeAssociation=false;associationService=null;}
    private void failAssociation(String message){
        if(!associationPending)return;
        RingService previousService=associationService;boolean resume=ringEnabledBeforeAssociation;
        clearPendingAssociation();
        if(resume&&previousService!=null)previousService.resumeAfterAssociation();
        if(message!=null&&!isFinishing()&&!isDestroyed())alert(message);
    }
    private void launchAssociation(IntentSender chooser){
        if(!associationPending)return;
        if(isFinishing()||isDestroyed()){failAssociation(null);return;}
        try{startIntentSenderForResult(chooser,44,null,0,0,0);}
        catch(Exception error){failAssociation("无法打开系统设备选择："+error.getMessage());}
    }
    private void completeAssociation(String address){
        getSharedPreferences("squidring",0).edit().putString("deviceAddress",address).apply();
        getSharedPreferences("press_to_think_ring_ble",0).edit().putString("device_address",address.toUpperCase(Locale.US)).apply();
        clearPendingAssociation();
        String observationFailure=null;
        try{
            if(Build.VERSION.SDK_INT>=31)((CompanionDeviceManager)getSystemService(COMPANION_DEVICE_SERVICE)).startObservingDevicePresence(address);
        }catch(Exception error){observationFailure=error.getMessage()==null?error.getClass().getSimpleName():error.getMessage();}
        connectWithoutNotificationPrompt();
        if(!isFinishing()&&!isDestroyed()){
            if(observationFailure==null)Toast.makeText(this,"已关联戒指并保存地址；请继续完成锁屏实测",Toast.LENGTH_LONG).show();
            else alert("已关联戒指并保存地址，但后台观察未启用："+observationFailure+"。可继续普通连接，请允许后台运行并完成锁屏实测");
        }
    }
    public final class Bridge {
        @JavascriptInterface public void command(String action,String payload){runOnUiThread(()->{
            try{
                if("connect".equals(action)){connectRing();return;}
                if("battery".equals(action)){startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));return;}
                if("appSettings".equals(action)){startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));return;}
                if(service==null){alert("后台服务正在启动，请稍后重试");return;}
                switch(action){
                    case "associate":associateRing();break;
                    case "submit":service.submitText(payload);break;
                    case "play":service.playLatest();break;
                    case "stop":service.stopSpeaking();break;
                    case "newTopic":service.newTopic();break;
                    case "select":service.selectThread(payload);break;
                    case "deep":service.setDeepMode("true".equals(payload));break;
                    case "recording":service.playRecording(payload);break;
                    case "check":service.checkBackend();break;
                    case "disconnect":startService(new Intent(MainActivity.this,RingService.class).setAction(RingService.STOP));break;
                    case "save":{
                        JSONObject values=new JSONObject(payload);String url=BackendClient.validateUrl(values.getString("backendUrl"));String token=values.optString("token");
                        String previous=getSharedPreferences("squidring",0).getString("backendUrl","http://127.0.0.1:3210");
                        if(!url.equals(previous))BackendClient.clearToken(MainActivity.this);
                        if(!token.trim().isEmpty())BackendClient.saveToken(MainActivity.this,token);
                        getSharedPreferences("squidring",0).edit().putString("backendUrl",url).putString("deviceAddress",values.optString("deviceAddress").trim()).apply();
                        service.setDeepMode(values.optBoolean("deepMode"));Toast.makeText(MainActivity.this,"已保存；更换设备后请重新连接",Toast.LENGTH_SHORT).show();render();break;
                    }
                    default:break;
                }
            }catch(Exception error){alert(error.getMessage()==null?"操作失败":error.getMessage());}
        });}
    }
    @Override public void onBackPressed(){web.evaluateJavascript("window.closeDrawers && window.closeDrawers()",null);moveTaskToBack(true);}
    @Override protected void onDestroy(){failAssociation(null);if(service!=null)service.unobserve(render);if(bound)unbindService(connection);web.removeJavascriptInterface("SquidNative");web.destroy();super.onDestroy();}
}
