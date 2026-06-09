export const appServiceWorkerPath = "/service-worker.js";
export const appServiceWorkerScope = "/";

type ServiceWorkerRegistrar = {
  register(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ): Promise<ServiceWorkerRegistration>;
};

type AppServiceWorkerContainer = ServiceWorkerRegistrar & {
  addEventListener?: (
    type: "controllerchange",
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
  controller?: ServiceWorker | null;
  ready?: Promise<ServiceWorkerRegistration>;
};

export type AppServiceWorkerNavigator = {
  serviceWorker?: AppServiceWorkerContainer;
};

export type AppServiceWorkerLocation = Pick<Location, "hostname" | "protocol">;

export type AppInstallAssetPreloadWindow = {
  addEventListener(
    type: "appinstalled" | "beforeinstallprompt",
    listener: () => void,
    options?: AddEventListenerOptions,
  ): void;
  matchMedia?: (query: string) => Pick<MediaQueryList, "matches">;
};

export type AppServiceWorkerEnvironment = {
  isProduction: boolean;
  location: AppServiceWorkerLocation;
  navigator: AppServiceWorkerNavigator;
};

export type AppServiceWorkerRegistrationOptions = Partial<AppServiceWorkerEnvironment> & {
  onError?: (error: unknown) => void;
  scope?: string;
  serviceWorkerPath?: string;
};

export type AppInstallAssetPreloadOptions = Partial<AppServiceWorkerEnvironment> & {
  controlTimeoutMs?: number;
  onError?: (error: unknown) => void;
  targetWindow?: AppInstallAssetPreloadWindow;
};

export type AppInstallAssetPreload = () => unknown;

export async function registerAppServiceWorker(options: AppServiceWorkerRegistrationOptions = {}) {
  let environment: AppServiceWorkerEnvironment = {
    isProduction: options.isProduction ?? import.meta.env.PROD,
    location: options.location ?? window.location,
    navigator: options.navigator ?? window.navigator,
  };

  if (!shouldRegisterAppServiceWorker(environment)) return null;

  try {
    return await environment.navigator.serviceWorker!.register(
      options.serviceWorkerPath ?? appServiceWorkerPath,
      { scope: options.scope ?? appServiceWorkerScope },
    );
  } catch (error) {
    options.onError?.(error);
    return null;
  }
}

export function preloadAppInstallAssets(
  preload: AppInstallAssetPreload,
  options: AppInstallAssetPreloadOptions = {},
) {
  let environment: AppServiceWorkerEnvironment = {
    isProduction: options.isProduction ?? import.meta.env.PROD,
    location: options.location ?? window.location,
    navigator: options.navigator ?? window.navigator,
  };
  if (!shouldRegisterAppServiceWorker(environment)) return false;

  let targetWindow = options.targetWindow ?? window;
  let started = false;
  let startPreload = () => {
    if (started) return;
    started = true;
    void waitForServiceWorkerControl(environment.navigator, options.controlTimeoutMs)
      .then(() => preload())
      .catch((error: unknown) => {
        options.onError?.(error);
      });
  };

  targetWindow.addEventListener("beforeinstallprompt", startPreload, { once: true });
  targetWindow.addEventListener("appinstalled", startPreload, { once: true });

  if (targetWindow.matchMedia?.("(display-mode: standalone)").matches) {
    setTimeout(startPreload, 0);
  }

  return true;
}

export function shouldRegisterAppServiceWorker({
  isProduction,
  location,
  navigator,
}: AppServiceWorkerEnvironment) {
  return Boolean(
    isProduction && navigator.serviceWorker && isServiceWorkerSecureLocation(location),
  );
}

async function waitForServiceWorkerControl(
  navigator: AppServiceWorkerNavigator,
  timeoutMs = 5_000,
) {
  let serviceWorker = navigator.serviceWorker;
  if (!serviceWorker) return;

  await serviceWorker.ready?.catch(() => undefined);
  if (serviceWorker.controller || !serviceWorker.addEventListener) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    let finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    let timeout = setTimeout(finish, timeoutMs);
    serviceWorker.addEventListener!("controllerchange", finish, { once: true });
  });
}

function isServiceWorkerSecureLocation({ hostname, protocol }: AppServiceWorkerLocation) {
  return (
    protocol == "https:" ||
    hostname == "localhost" ||
    hostname == "127.0.0.1" ||
    hostname == "[::1]"
  );
}
