package com.goymusic.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Регистрируем мост к python/api.py до создания вебвью, иначе первые вызовы
        // из JS уйдут в пустоту.
        registerPlugin(PythonBackendPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
