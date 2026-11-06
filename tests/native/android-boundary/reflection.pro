# Only the disposable boundary app uses these rules. Keep the exact members the
# independently compiled instrumentation observes or calls in the Release APK.
-keep class org.nostrocket.hypergolic.host.CapabilityTransport {
    public static final org.nostrocket.hypergolic.host.CapabilityTransport INSTANCE;
    public org.nostrocket.hypergolic.host.CapabilityLeaseRegistry getLeases();
    public void finish(java.lang.String, java.lang.String);
    public void foreground(boolean);
}

-keep class org.nostrocket.hypergolic.host.CapabilityLeaseRegistry {
    private java.util.Map requests;
    public java.lang.String take(java.lang.String);
    public boolean isActive(java.lang.String);
    public boolean sessionActive(java.lang.String);
}

-keep class org.nostrocket.hypergolic.host.CapabilityLeaseRegistry$Request {
    java.lang.String generation;
}

-keep class org.nostrocket.hypergolic.host.NappletHostView {
    public <init>(android.content.Context, expo.modules.kotlin.AppContext);
    public void startConfiguredSession(java.lang.String);
    public void destroySession();
    private android.webkit.WebView webView;
    private java.lang.String generation;
    private boolean ready;
    private boolean disposed;
}

-keep class org.nostrocket.hypergolic.host.BuildConfig {
    public static final boolean UPLOAD_NETWORK_PROOF;
}
