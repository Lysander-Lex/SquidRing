package com.presstothink.v2;

import android.Manifest;
import android.annotation.TargetApi;
import android.companion.AssociationInfo;
import android.companion.CompanionDeviceService;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

/** System-bound presence callback for a user-approved companion association. */
@TargetApi(31)
public final class RingCompanionService extends CompanionDeviceService {
    @Override public void onDeviceAppeared(String address){resume(address);}
    @Override public void onDeviceDisappeared(String address){}
    @Override public void onDeviceAppeared(AssociationInfo info){if(Build.VERSION.SDK_INT>=33&&info.getDeviceMacAddress()!=null)resume(info.getDeviceMacAddress().toString());}
    @Override public void onDeviceDisappeared(AssociationInfo info){}
    private void resume(String address){
        if(!getSharedPreferences("squidring",0).getBoolean("enabled",false))return;
        String saved=getSharedPreferences("press_to_think_ring_ble",0).getString("device_address","");
        if(!saved.equalsIgnoreCase(address))return;
        if(checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)!=PackageManager.PERMISSION_GRANTED||checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)!=PackageManager.PERMISSION_GRANTED)return;
        try{startForegroundService(new Intent(this,RingService.class).setAction(RingService.PRESENCE));}
        catch(RuntimeException error){Log.w("SquidRing","系统暂不允许恢复连接，请打开应用连接戒指",error);}
    }
}
