package com.cromachina.psdexport;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;

import java.io.OutputStream;

import androidx.documentfile.provider.DocumentFile;

/**
 * Lets the user pick WHERE the export archive goes, using the system
 * "Save to..." document picker (Storage Access Framework).
 *
 * The writer streams chunks straight into the chosen Uri, so a multi-hundred
 * megabyte archive never has to exist in memory or in app-private storage.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    private OutputStream stream;
    private Uri targetUri;
    private DocumentFile directory;
    private DocumentFile outputFile;
    private OutputStream outputStream;

    @PluginMethod
    public void chooseFile(PluginCall call) {
        String fileName = call.getString("fileName", "psd-export.zip");
        String mime = call.getString("mimeType", "application/zip");

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);

        startActivityForResult(call, intent, "fileChosen");
    }

    @PluginMethod
    public void chooseDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "directoryChosen");
    }

    @ActivityCallback
    private void directoryChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("已取消");
            return;
        }
        Uri uri = result.getData().getData();
        try {
            final int takeFlags = result.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContext().getContentResolver().takePersistableUriPermission(uri, takeFlags);
        } catch (Exception ignored) {
            // Some providers do not offer persistable grants; the current activity grant is enough.
        }
        DocumentFile dir = DocumentFile.fromTreeUri(getContext(), uri);
        if (dir == null || !dir.canWrite()) {
            call.reject("无法写入所选文件夹");
            return;
        }
        directory = dir;
        targetUri = uri;
        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        call.resolve(ret);
    }

    @PluginMethod
    public void beginOutputFile(PluginCall call) {
        String relative = call.getString("path");
        if (relative == null || relative.isEmpty()) {
            call.reject("缺少文件路径");
            return;
        }
        if (directory == null) {
            call.reject("尚未选择保存文件夹");
            return;
        }
        DocumentFile parent = directory;
        String[] parts = relative.replace('\\', '/').split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            String part = parts[i];
            if (part.isEmpty() || part.equals(".") || part.equals("..")) continue;
            DocumentFile child = parent.findFile(part);
            if (child == null) child = parent.createDirectory(part);
            if (child == null || !child.isDirectory()) {
                call.reject("无法创建子文件夹: " + part);
                return;
            }
            parent = child;
        }
        String name = parts[parts.length - 1];
        if (name.isEmpty() || name.equals(".") || name.equals("..")) {
            call.reject("文件名无效");
            return;
        }
        try {
            DocumentFile old = parent.findFile(name);
            if (old != null) old.delete();
            DocumentFile file = parent.createFile(mimeFor(name), name);
            if (file == null) {
                call.reject("无法创建文件: " + name);
                return;
            }
            outputFile = file;
            outputStream = getContext().getContentResolver().openOutputStream(file.getUri(), "wt");
            if (outputStream == null) {
                call.reject("无法写入文件: " + name);
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("写入失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void appendOutputChunk(PluginCall call) {
        String base64 = call.getString("data");
        if (base64 == null || outputStream == null) {
            call.reject("输出文件未打开");
            return;
        }
        try {
            outputStream.write(android.util.Base64.decode(base64, android.util.Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("写入失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void finishOutputFile(PluginCall call) {
        try {
            if (outputStream != null) {
                outputStream.flush();
                outputStream.close();
            }
            outputStream = null;
            outputFile = null;
            call.resolve();
        } catch (Exception e) {
            call.reject("关闭文件失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void abortOutputFile(PluginCall call) {
        try {
            if (outputStream != null) outputStream.close();
        } catch (Exception ignored) {
        }
        outputStream = null;
        if (outputFile != null) outputFile.delete();
        outputFile = null;
        call.resolve();
    }

    @PluginMethod
    public void closeDirectory(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("uri", targetUri == null ? "" : targetUri.toString());
        directory = null;
        call.resolve(ret);
    }

    @PluginMethod
    public void abortDirectory(PluginCall call) {
        try {
            if (outputStream != null) outputStream.close();
        } catch (Exception ignored) {
        }
        outputStream = null;
        if (outputFile != null) outputFile.delete();
        outputFile = null;
        directory = null;
        targetUri = null;
        call.resolve();
    }

    private static String mimeFor(String name) {
        return name.toLowerCase().endsWith(".png") ? "image/png" : "application/octet-stream";
    }

    @ActivityCallback
    private void fileChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("已取消");
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("未选择保存位置");
            return;
        }
        try {
            closeStream();
            OutputStream os = getContext().getContentResolver().openOutputStream(uri, "wt");
            if (os == null) {
                call.reject("无法写入所选位置");
                return;
            }
            this.stream = os;
            this.targetUri = uri;
            JSObject ret = new JSObject();
            ret.put("uri", uri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("无法打开所选位置: " + e.getMessage());
        }
    }

    @PluginMethod
    public void appendChunk(PluginCall call) {
        String base64 = call.getString("data");
        if (base64 == null) {
            call.reject("缺少数据");
            return;
        }
        if (stream == null) {
            call.reject("尚未选择保存位置");
            return;
        }
        try {
            byte[] bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
            stream.write(bytes);
            call.resolve();
        } catch (Exception e) {
            call.reject("写入失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void closeFile(PluginCall call) {
        try {
            closeStream();
            JSObject ret = new JSObject();
            ret.put("uri", targetUri == null ? "" : targetUri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("关闭文件失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void abortFile(PluginCall call) {
        try {
            closeStream();
        } catch (Exception ignored) {
        }
        // remove the half-written archive so the user is not left with a broken ZIP
        if (targetUri != null) {
            try {
                android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), targetUri);
            } catch (Exception ignored) {
            }
            targetUri = null;
        }
        call.resolve();
    }

    private void closeStream() throws Exception {
        if (stream != null) {
            try {
                stream.flush();
            } finally {
                stream.close();
            }
            stream = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            closeStream();
        } catch (Exception ignored) {
        }
        directory = null;
        outputFile = null;
        outputStream = null;
        super.handleOnDestroy();
    }
}
