package com.goymusic.app;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Мост между вебвью и python/api.py, живущим в этом же процессе через Chaquopy.
 *
 * Протокол ровно тот же, что у десктопа: наверх уходит JSON-строка запроса, обратно
 * приходят JSON-строки ответов, а сопоставление по callId делает JS. Благодаря этому
 * ни api.py, ни рендерер про Android ничего не знают.
 */
@CapacitorPlugin(name = "PythonBackend")
public class PythonBackendPlugin extends Plugin {

    /** Chaquopy не делает java-объекты вызываемыми из Python, поэтому именованные методы. */
    public class Emitter {
        public void onLine(String line) {
            JSObject data = new JSObject();
            data.put("line", line);
            notifyListeners("pyLine", data);
        }

        /**
         * Синхронно выполняет JS в вебвью и возвращает результат в JSON-виде.
         *
         * Нужно для расшифровки подписей YouTube: Node на Android нет, а JS-движок есть --
         * тот самый, в котором работает интерфейс. Вызывается из питоновских рабочих
         * потоков, поэтому блокировка безопасна; с UI-потока вызвать нельзя -- будет
         * дедлок, но питон там и не живёт.
         */
        public String runJs(final String code) throws Exception {
            final CountDownLatch latch = new CountDownLatch(1);
            final String[] out = new String[1];
            getActivity().runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        getBridge().getWebView().evaluateJavascript(code, new android.webkit.ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                out[0] = value;
                                latch.countDown();
                            }
                        });
                    } catch (Throwable t) {
                        out[0] = null;
                        latch.countDown();
                    }
                }
            });
            if (!latch.await(30, TimeUnit.SECONDS)) {
                throw new RuntimeException("js evaluation timed out");
            }
            return out[0];
        }
    }

    private PyObject host;
    private String startError;

    @Override
    public void load() {
        // Старт питона тяжёлый (распаковка stdlib при первом запуске) -- уводим с UI-потока,
        // иначе приложение показывает белый экран на несколько секунд.
        new Thread(() -> {
            try {
                if (!Python.isStarted()) {
                    Python.start(new AndroidPlatform(getContext()));
                }
                PyObject module = Python.getInstance().getModule("mobile_host");
                module.callAttr("start", getContext().getFilesDir().getAbsolutePath(), new Emitter());
                host = module;
                JSObject ready = new JSObject();
                ready.put("ok", true);
                notifyListeners("pyReady", ready);
            } catch (Throwable t) {
                android.util.Log.e("GoyPython", "python start failed", t);
                startError = String.valueOf(t);
                JSObject ready = new JSObject();
                ready.put("ok", false);
                ready.put("error", startError);
                notifyListeners("pyReady", ready);
            }
        }, "python-boot").start();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String line = call.getString("line");
        if (line == null) {
            call.reject("line is required");
            return;
        }
        if (host == null) {
            call.reject(startError != null ? startError : "python not started yet");
            return;
        }
        try {
            host.callAttr("call", line);
            call.resolve();
        } catch (Throwable t) {
            call.reject(String.valueOf(t));
        }
    }

    /**
     * Вход в YouTube. Десктоп открывает окно и перехватывает заголовки запроса к
     * youtubei, но на Android это лишнее: ytmusicapi умеет считать SAPISIDHASH из куки
     * сам (fork/ytmusicapi/helpers.py), поэтому достаточно забрать Cookie из WebView.
     */
    @PluginMethod
    public void youtubeLogin(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                final android.webkit.WebView web = new android.webkit.WebView(getContext());
                web.getSettings().setJavaScriptEnabled(true);
                web.getSettings().setDomStorageEnabled(true);
                // Google отказывает встроенным вебвью, если видит их UA -- представляемся
                // обычным мобильным Chrome.
                web.getSettings().setUserAgentString(
                    "Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/122.0.0.0 Mobile Safari/537.36");
                final android.webkit.CookieManager cookies = android.webkit.CookieManager.getInstance();
                cookies.setAcceptCookie(true);
                cookies.setAcceptThirdPartyCookies(web, true);

                android.widget.LinearLayout root = new android.widget.LinearLayout(getContext());
                root.setOrientation(android.widget.LinearLayout.VERTICAL);
                final android.widget.Button close = new android.widget.Button(getContext());
                close.setText("Закрыть");
                root.addView(close, new android.widget.LinearLayout.LayoutParams(
                        android.widget.LinearLayout.LayoutParams.MATCH_PARENT,
                        android.widget.LinearLayout.LayoutParams.WRAP_CONTENT));
                root.addView(web, new android.widget.LinearLayout.LayoutParams(
                        android.widget.LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

                final android.app.Dialog dialog = new android.app.Dialog(getActivity());
                dialog.setContentView(root);

                final boolean[] done = { false };
                final android.os.Handler handler = new android.os.Handler(android.os.Looper.getMainLooper());

                // music.youtube.com -- SPA: onPageFinished после логина может не прийти
                // вовсе, поэтому куки опрашиваем по таймеру, а не по событию страницы.
                final Runnable poll = new Runnable() {
                    @Override
                    public void run() {
                        if (done[0]) return;
                        String cookie = cookies.getCookie("https://music.youtube.com");
                        if (cookie != null && cookie.contains("SAPISID")) {
                            done[0] = true;
                            cookies.flush();
                            try {
                                org.json.JSONObject data = new org.json.JSONObject();
                                data.put("User-Agent", web.getSettings().getUserAgentString());
                                data.put("Accept", "*/*");
                                data.put("Accept-Language", "en-US,en;q=0.9");
                                data.put("Content-Type", "application/json");
                                data.put("X-Goog-AuthUser", "0");
                                data.put("x-origin", "https://music.youtube.com");
                                data.put("Cookie", cookie);
                                writeAuthFile(data.toString(4));
                                dialog.dismiss();
                                JSObject res = new JSObject();
                                res.put("status", "ok");
                                call.resolve(res);
                            } catch (Throwable t) {
                                dialog.dismiss();
                                call.reject(String.valueOf(t));
                            }
                            return;
                        }
                        handler.postDelayed(this, 1000);
                    }
                };

                close.setOnClickListener(new android.view.View.OnClickListener() {
                    @Override
                    public void onClick(android.view.View v) {
                        dialog.dismiss();
                    }
                });

                dialog.setOnDismissListener(new android.content.DialogInterface.OnDismissListener() {
                    @Override
                    public void onDismiss(android.content.DialogInterface d) {
                        handler.removeCallbacks(poll);
                        if (!done[0]) {
                            done[0] = true;
                            JSObject res = new JSObject();
                            res.put("status", "cancelled");
                            call.resolve(res);
                        }
                    }
                });

                dialog.show();
                web.loadUrl("https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com/");
                handler.postDelayed(poll, 2000);
            }
        });
    }

    /** Запасной путь: перенести готовый browser.json с компьютера. */
    @PluginMethod
    public void importAuth(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) {
            call.reject("json is required");
            return;
        }
        try {
            writeAuthFile(json);
            JSObject res = new JSObject();
            res.put("status", "ok");
            call.resolve(res);
        } catch (Throwable t) {
            call.reject(String.valueOf(t));
        }
    }

    private void writeAuthFile(String json) throws Exception {
        java.io.File f = new java.io.File(getContext().getFilesDir(), "browser.json");
        java.io.FileOutputStream out = new java.io.FileOutputStream(f);
        try {
            out.write(json.getBytes("UTF-8"));
        } finally {
            out.close();
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject res = new JSObject();
        res.put("ready", host != null);
        if (startError != null) res.put("error", startError);
        call.resolve(res);
    }
}
