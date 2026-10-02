import { useEffect, useState } from "react";
import { Download, X, Share } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

// Global reference for access by header or navigation install buttons
let globalDeferredPrompt: BeforeInstallPromptEvent | null = null;

export function triggerPwaInstall() {
  if (globalDeferredPrompt) {
    globalDeferredPrompt.prompt().then(() => {
      // Prompt opened
    });
  } else {
    window.dispatchEvent(new CustomEvent("dv_open_install_prompt"));
  }
}

export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // 1. Always register Service Worker in supporting environments (even in standalone mode)
    if ("serviceWorker" in navigator) {
      const isLocalhost =
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1";
      if (window.location.protocol === "https:" || isLocalhost) {
        window.addEventListener("load", () => {
          navigator.serviceWorker
            .register("/sw.js")
            .then((reg) => {
              reg.onupdatefound = () => {
                const installingWorker = reg.installing;
                if (!installingWorker) return;
                installingWorker.onstatechange = () => {
                  if (
                    installingWorker.state === "installed" &&
                    navigator.serviceWorker.controller
                  ) {
                    installingWorker.postMessage({ type: "SKIP_WAITING" });
                  }
                };
              };
            })
            .catch((err) => {
              console.warn("[PWA] Service worker registration failed:", err);
            });
        });
      }
    }

    // 2. Check if already running as installed standalone PWA
    const inStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsStandalone(inStandalone);

    // 3. Detect iOS device
    const userAgent = window.navigator.userAgent.toLowerCase();
    const isAppleDevice = /iphone|ipad|ipod/.test(userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
    setIsIOS(isAppleDevice);

    // If running inside standalone app, do not display install banners
    if (inStandalone) return;

    let timer: NodeJS.Timeout | null = null;

    // Capture Chrome/Android/Edge beforeinstallprompt event
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      const installEvent = e as BeforeInstallPromptEvent;
      globalDeferredPrompt = installEvent;
      setDeferredPrompt(installEvent);

      // Check if user dismissed prompt in this session
      const dismissed = sessionStorage.getItem("dv_pwa_dismissed");
      if (!dismissed) {
        timer = setTimeout(() => {
          setShowPrompt(true);
        }, 3000);
      }
    };

    // App installed event
    const handleAppInstalled = () => {
      setShowPrompt(false);
      setDeferredPrompt(null);
      globalDeferredPrompt = null;
      setIsStandalone(true);
      sessionStorage.setItem("dv_pwa_dismissed", "true");
    };

    // Custom event to manually open install prompt or guide from any button
    const handleManualOpen = () => {
      if (isAppleDevice) {
        setShowIOSGuide(true);
      }
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    window.addEventListener("dv_open_install_prompt", handleManualOpen);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      window.removeEventListener("dv_open_install_prompt", handleManualOpen);
    };
  }, []);

  const handleInstallClick = async () => {
    if (isIOS) {
      setShowIOSGuide(true);
      return;
    }

    if (!deferredPrompt && !globalDeferredPrompt) {
      // Fallback for browsers that don't support beforeinstallprompt
      setShowIOSGuide(true);
      return;
    }

    const promptToUse = deferredPrompt || globalDeferredPrompt;
    if (promptToUse) {
      await promptToUse.prompt();
      const { outcome } = await promptToUse.userChoice;
      if (outcome === "accepted") {
        setShowPrompt(false);
        setDeferredPrompt(null);
        globalDeferredPrompt = null;
      }
    }
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    setShowIOSGuide(false);
    sessionStorage.setItem("dv_pwa_dismissed", "true");
  };

  // Do not render if app is already installed/standalone or prompt is hidden
  if (isStandalone || (!showPrompt && !showIOSGuide)) {
    return null;
  }

  return (
    <aside
      aria-label="Install Dink Valley App"
      className="fixed z-50 bottom-20 sm:bottom-6 sm:right-6 inset-x-3 sm:inset-x-auto sm:max-w-sm animate-in fade-in slide-in-from-bottom-5 duration-300"
    >
      <div className="surface-card bg-card border-2 border-border rounded-xl p-4 shadow-2xl space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <img
              src="/DinkValley.jpg"
              alt="Dink Valley"
              className="h-10 w-10 rounded-full object-cover ring-2 ring-brick shrink-0"
            />
            <div className="min-w-0">
              <span className="text-[0.6rem] font-bold uppercase tracking-[0.25em] text-pickle block">
                Progressive Web App
              </span>
              <h4 className="font-display text-lg text-foreground font-bold leading-tight truncate">
                Install Dink Valley
              </h4>
            </div>
          </div>

          <button
            onClick={handleDismiss}
            aria-label="Dismiss install banner"
            className="text-muted-foreground hover:text-foreground p-1 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        {!showIOSGuide ? (
          <>
            <p className="text-xs text-foreground/80 leading-relaxed">
              Add Dink Valley to your home screen for fast access, offline tournament scores, and full-screen court view.
            </p>

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleInstallClick}
                className="flex-1 bg-brick hover:bg-brick-deep text-sand text-xs font-bold uppercase tracking-wider py-2.5 px-3 rounded flex items-center justify-center gap-1.5 transition-colors cursor-pointer shadow-md"
              >
                <Download size={14} />
                <span>Install App</span>
              </button>
              <button
                onClick={handleDismiss}
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground py-2 px-3 transition-colors cursor-pointer"
              >
                Later
              </button>
            </div>
          </>
        ) : (
          /* iOS Safari / Other Browser Step-by-Step Guide */
          <div className="space-y-2 pt-1 border-t-2 border-border">
            <p className="text-xs text-foreground font-bold">
              {isIOS ? "To install on your iOS device:" : "To install this web app:"}
            </p>
            <ol className="text-xs text-foreground/80 space-y-1.5 list-decimal list-inside font-medium">
              {isIOS ? (
                <>
                  <li>
                    Tap the <Share size={12} className="inline mx-1 text-pickle" /> Share button in Safari toolbar.
                  </li>
                  <li>Scroll down and select <strong>Add to Home Screen</strong>.</li>
                  <li>Tap <strong>Add</strong> in the top right corner.</li>
                </>
              ) : (
                <>
                  <li>Open the browser options menu (three dots in Chrome/Edge).</li>
                  <li>Select <strong>Install Dink Valley</strong> or <strong>Add to Home screen</strong>.</li>
                  <li>Confirm installation.</li>
                </>
              )}
            </ol>
            <button
              onClick={handleDismiss}
              className="w-full mt-2 bg-card border-2 border-border text-foreground hover:border-pickle hover:text-pickle text-xs font-bold uppercase tracking-wider py-2 rounded transition-colors cursor-pointer"
            >
              Got it
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
