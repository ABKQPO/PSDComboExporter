package com.cromachina.psdexport;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin: system "Save to..." picker for the export archive.
        registerPlugin(SaveFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
