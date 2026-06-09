import { describe, expect, it, vi } from "vite-plus/test";
import {
  appServiceWorkerPath,
  appServiceWorkerScope,
  preloadAppInstallAssets,
  registerAppServiceWorker,
  shouldRegisterAppServiceWorker,
  type AppInstallAssetPreloadWindow,
  type AppServiceWorkerEnvironment,
} from "./pwa.ts";

describe("PWA service worker registration", () => {
  it("only registers for production builds with service worker support", () => {
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          isProduction: false,
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          isProduction: true,
          protocol: "http:",
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(false);
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          isProduction: true,
          serviceWorker: undefined,
        }),
      ),
    ).toBe(false);
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          hostname: "app.grovemd.net",
          isProduction: true,
          protocol: "https:",
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(true);
  });

  it("allows production preview on localhost", () => {
    expect(
      shouldRegisterAppServiceWorker(
        environment({
          hostname: "localhost",
          isProduction: true,
          protocol: "http:",
          serviceWorker: { register: vi.fn() },
        }),
      ),
    ).toBe(true);
  });

  it("registers the root-scoped app service worker", async () => {
    let registration = {} as ServiceWorkerRegistration;
    let register = vi.fn(async () => registration);

    await expect(
      registerAppServiceWorker({
        isProduction: true,
        location: { hostname: "app.grovemd.net", protocol: "https:" },
        navigator: { serviceWorker: { register } },
      }),
    ).resolves.toBe(registration);

    expect(register).toHaveBeenCalledWith(appServiceWorkerPath, { scope: appServiceWorkerScope });
  });

  it("reports registration failures without breaking app startup", async () => {
    let error = new Error("registration denied");
    let onError = vi.fn();
    let register = vi.fn(async () => {
      throw error;
    });

    await expect(
      registerAppServiceWorker({
        isProduction: true,
        location: { hostname: "app.grovemd.net", protocol: "https:" },
        navigator: { serviceWorker: { register } },
        onError,
      }),
    ).resolves.toBeNull();

    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe("PWA install asset preloading", () => {
  it("only installs preload listeners in production service worker environments", () => {
    let preload = vi.fn();
    let { targetWindow } = installTargetWindow();

    expect(
      preloadAppInstallAssets(preload, {
        isProduction: false,
        location: { hostname: "app.grovemd.net", protocol: "https:" },
        navigator: { serviceWorker: { register: vi.fn() } },
        targetWindow,
      }),
    ).toBe(false);

    expect(targetWindow.addEventListener).not.toHaveBeenCalled();
    expect(preload).not.toHaveBeenCalled();
  });

  it("preloads install assets after the service worker controls the page", async () => {
    let preload = vi.fn();
    let { listeners, targetWindow } = installTargetWindow();
    let controllerChange: (() => void) | undefined;
    let serviceWorker = {
      addEventListener: vi.fn((_type: "controllerchange", listener: () => void) => {
        controllerChange = listener;
      }),
      controller: null,
      ready: Promise.resolve({} as ServiceWorkerRegistration),
      register: vi.fn(),
    };

    expect(
      preloadAppInstallAssets(preload, {
        controlTimeoutMs: 50,
        isProduction: true,
        location: { hostname: "app.grovemd.net", protocol: "https:" },
        navigator: { serviceWorker },
        targetWindow,
      }),
    ).toBe(true);

    expect(targetWindow.addEventListener).toHaveBeenCalledWith(
      "beforeinstallprompt",
      expect.any(Function),
      { once: true },
    );
    expect(targetWindow.addEventListener).toHaveBeenCalledWith(
      "appinstalled",
      expect.any(Function),
      { once: true },
    );

    listeners.get("beforeinstallprompt")!();
    await flushAsync();

    expect(preload).not.toHaveBeenCalled();
    expect(serviceWorker.addEventListener).toHaveBeenCalledWith(
      "controllerchange",
      expect.any(Function),
      { once: true },
    );

    controllerChange!();
    await flushAsync();

    expect(preload).toHaveBeenCalledTimes(1);

    listeners.get("appinstalled")!();
    await flushAsync();

    expect(preload).toHaveBeenCalledTimes(1);
  });

  it("preloads install assets when launched in standalone display mode", async () => {
    let preload = vi.fn();
    let { targetWindow } = installTargetWindow({ standalone: true });

    preloadAppInstallAssets(preload, {
      isProduction: true,
      location: { hostname: "app.grovemd.net", protocol: "https:" },
      navigator: {
        serviceWorker: {
          controller: {} as ServiceWorker,
          ready: Promise.resolve({} as ServiceWorkerRegistration),
          register: vi.fn(),
        },
      },
      targetWindow,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushAsync();

    expect(preload).toHaveBeenCalledTimes(1);
  });

  it("reports preload failures without breaking app startup", async () => {
    let error = new Error("preload failed");
    let onError = vi.fn();
    let preload = vi.fn(async () => {
      throw error;
    });
    let { listeners, targetWindow } = installTargetWindow();

    preloadAppInstallAssets(preload, {
      isProduction: true,
      location: { hostname: "app.grovemd.net", protocol: "https:" },
      navigator: {
        serviceWorker: {
          controller: {} as ServiceWorker,
          ready: Promise.resolve({} as ServiceWorkerRegistration),
          register: vi.fn(),
        },
      },
      onError,
      targetWindow,
    });

    listeners.get("appinstalled")!();
    await flushAsync();

    expect(onError).toHaveBeenCalledWith(error);
  });
});

function environment({
  hostname = "app.grovemd.net",
  isProduction = true,
  protocol = "https:",
  serviceWorker,
}: {
  hostname?: string;
  isProduction?: boolean;
  protocol?: string;
  serviceWorker?: AppServiceWorkerEnvironment["navigator"]["serviceWorker"];
}): AppServiceWorkerEnvironment {
  return {
    isProduction,
    location: { hostname, protocol },
    navigator: { serviceWorker },
  };
}

function installTargetWindow({ standalone = false } = {}) {
  let listeners = new Map<"appinstalled" | "beforeinstallprompt", () => void>();
  let targetWindow = {
    addEventListener: vi.fn(
      (type: "appinstalled" | "beforeinstallprompt", listener: () => void) => {
        listeners.set(type, listener);
      },
    ),
    matchMedia: vi.fn((query: string) => ({
      matches: query == "(display-mode: standalone)" && standalone,
    })),
  } satisfies AppInstallAssetPreloadWindow;

  return { listeners, targetWindow };
}

async function flushAsync() {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}
